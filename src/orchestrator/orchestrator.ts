import type { AppConfig } from "../config.ts";
import { getRequestId, type CodexClient } from "../codex/client.ts";
import type { CodexNotification, CodexServerRequest } from "../codex/protocol.ts";
import type { Logger } from "../logger.ts";
import type { AgentSession, ApprovalResolution, Repositories } from "../db/repositories.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import type { SlackInput } from "../slack/input.ts";
import type { SlackRenderer } from "../slack/renderer.ts";
import type { SlackThreadContextProvider } from "../slack/thread-context.ts";
import { assertAllowed } from "./policy.ts";

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type OrchestratorRepositories = Pick<
  Repositories,
  | "resolveSlackThread"
  | "resolveSession"
  | "createTurn"
  | "bindCodexThread"
  | "bindCodexTurn"
  | "completeTurn"
  | "findSessionByCodexThreadId"
  | "recordCodexEvent"
  | "recordDeniedApproval"
  | "recordPendingApproval"
  | "setApprovalSlackMessage"
  | "resolveApprovalRequest"
>;

export type OrchestratorCodexClient = Pick<
  CodexClient,
  | "onNotification"
  | "onServerRequest"
  | "startThread"
  | "resumeThread"
  | "runTurn"
>;

export type SlackOutput = Pick<
  SlackRenderer,
  | "setAssistantStatus"
  | "postThreadMessage"
  | "startThreadStream"
  | "appendThreadStream"
  | "stopThreadStream"
  | "postApprovalRequest"
  | "updateApprovalRequest"
>;

type ActiveSlackTurn = {
  renderer: SlackOutput;
  channelId: string;
  threadTs: string;
};

type PendingApproval = {
  request: CodexServerRequest;
  channelId: string;
  messageTs: string | null;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
};

type SlackInputOptions = {
  threadContextProvider?: SlackThreadContextProvider;
};

export class Orchestrator {
  private readonly config: AppConfig;
  private readonly repos: OrchestratorRepositories;
  private readonly codex: OrchestratorCodexClient;
  private readonly logger: Pick<Logger, "debug" | "error">;
  private readonly activeSlackTurns = new Map<string, ActiveSlackTurn>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    config: AppConfig,
    repos: OrchestratorRepositories,
    codex: OrchestratorCodexClient,
    logger: Pick<Logger, "debug" | "error">,
  ) {
    this.config = config;
    this.repos = repos;
    this.codex = codex;
    this.logger = logger;
    this.codex.onNotification((notification) => this.recordCodexNotification(notification));
    this.codex.onServerRequest((request) => this.recordAndRequestApproval(request));
  }

  async handleSlackInput(
    input: SlackInput,
    renderer: SlackOutput,
    options: SlackInputOptions = {},
  ): Promise<void> {
    assertAllowed(this.config, input);

    if (!input.text.trim()) {
      await renderer.postThreadMessage({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: "The message was empty. Send the text you want Codex to handle.",
      });
      return;
    }

    const slackThread = this.repos.resolveSlackThread({
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      rootMessageTs: input.threadTs,
      userId: input.userId,
    });
    const session = this.repos.resolveSession({
      slackThreadId: slackThread.id,
      userId: input.userId,
      model: this.config.codexDefaultModel,
      approvalPolicy: this.config.codexApprovalPolicy,
      sandboxPolicy: this.config.codexSandbox,
    });

    if (session.state === "running") {
      await renderer.postThreadMessage({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: "Another Codex turn is already running in this Slack thread. Try again after it finishes.",
      });
      return;
    }

    const generation = session.activeGeneration + 1;
    const shouldPrependThreadContext = shouldFetchThreadContext(input, session);
    const turn = this.repos.createTurn({
      sessionId: session.id,
      generation,
      userMessageTs: input.messageTs,
      inputText: input.text,
      classifiedIntent: "start_turn",
    });

    if (!turn) {
      await renderer.postThreadMessage({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: "Another Codex turn is already running in this Slack thread. Try again after it finishes.",
      });
      return;
    }

    await renderer.setAssistantStatus({
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: "Thinking...",
      loadingMessages: [
        "Sending the request to Codex...",
        "Generating a response...",
      ],
    });

    let appendQueue = Promise.resolve();
    let streamTs: string | null = null;
    let streamedAny = false;
    let streamFailed = false;

    try {
      const codexThreadId = await this.ensureCodexThread(session);
      this.activeSlackTurns.set(session.id, {
        renderer,
        channelId: input.channelId,
        threadTs: input.threadTs,
      });
      const codexInputText = await this.prepareCodexInputText(
        input,
        shouldPrependThreadContext,
        options.threadContextProvider,
      );

      const stream = await renderer.startThreadStream({
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        userId: input.userId,
      });
      streamTs = stream?.streamTs ?? null;
      const activeStreamTs = streamTs;

      const result = await this.codex.runTurn({
        threadId: codexThreadId,
        text: codexInputText,
        cwd: this.config.codexDefaultCwd,
        clientUserMessageId: input.messageTs,
        onDelta: activeStreamTs
          ? (delta) => {
            streamedAny = true;
            appendQueue = appendQueue
              .then(() =>
                renderer.appendThreadStream({
                  channelId: input.channelId,
                  streamTs: activeStreamTs,
                  text: delta,
                })
              )
              .catch((error: unknown) => {
                streamFailed = true;
                this.logger.debug("slack stream append skipped", {
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
          : undefined,
      });
      await appendQueue;
      this.repos.bindCodexTurn(turn.id, result.turnId);

      const finalText = formatFinalText(result, turn.id);
      if (streamTs) {
        await renderer.stopThreadStream({
          channelId: input.channelId,
          streamTs,
          text: streamedAny && !streamFailed && result.status === "completed" ? undefined : finalText,
        });
      } else {
        await renderer.postThreadMessage({
          channelId: input.channelId,
          threadTs: input.threadTs,
          text: finalText,
        });
      }

      this.repos.completeTurn({
        sessionId: session.id,
        turnId: turn.id,
        state: result.status === "failed" || result.status === "interrupted"
          ? result.status
          : "completed",
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("turn failed", {
        sessionId: session.id,
        turnId: turn.id,
        error: redactSensitiveText(message),
      });
      this.repos.completeTurn({
        sessionId: session.id,
        turnId: turn.id,
        state: "failed",
        errorMessage: message,
      });
      await appendQueue;
      if (streamTs) {
        await renderer.stopThreadStream({
          channelId: input.channelId,
          streamTs,
          text: failureMessage(turn.id),
        });
      } else {
        await renderer.postThreadMessage({
          channelId: input.channelId,
          threadTs: input.threadTs,
          text: failureMessage(turn.id),
        });
      }
    } finally {
      this.activeSlackTurns.delete(session.id);
      await renderer.setAssistantStatus({
        channelId: input.channelId,
        threadTs: input.threadTs,
        status: "",
      });
    }
  }

  private async ensureCodexThread(session: AgentSession): Promise<string> {
    if (session.codexThreadId) {
      await this.codex.resumeThread(session.codexThreadId);
      return session.codexThreadId;
    }

    const { threadId } = await this.codex.startThread({
      cwd: this.config.codexDefaultCwd,
      model: this.config.codexDefaultModel,
      approvalPolicy: this.config.codexApprovalPolicy,
      sandbox: this.config.codexSandbox,
    });
    this.repos.bindCodexThread(session.id, threadId);
    return threadId;
  }

  private async prepareCodexInputText(
    input: SlackInput,
    shouldPrependThreadContext: boolean,
    provider: SlackThreadContextProvider | undefined,
  ): Promise<string> {
    if (!shouldPrependThreadContext || !provider) return input.text;

    try {
      const context = await provider.fetchThreadContext({
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        currentTs: input.messageTs,
      });
      return context ? context + input.text : input.text;
    } catch (error) {
      this.logger.debug("slack thread context skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return input.text;
    }
  }

  private recordCodexNotification(notification: CodexNotification): void {
    const params = notification.params;
    const codexThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!codexThreadId) return;
    const session = this.repos.findSessionByCodexThreadId(codexThreadId);
    if (!session) return;
    const codexTurnId = extractTurnId(params);
    this.repos.recordCodexEvent({
      sessionId: session.id,
      turnId: session.activeTurnId,
      codexThreadId,
      codexTurnId,
      eventType: notification.method,
      payload: params ?? {},
      generation: session.activeGeneration,
    });
  }

  async handleApprovalAction(input: {
    approvalRequestId: string;
    actorSlackUserId: string;
    decision: ApprovalResolution;
    channelId: string;
    messageTs: string;
    renderer: Pick<SlackRenderer, "updateApprovalRequest">;
  }): Promise<void> {
    const pending = this.pendingApprovals.get(input.approvalRequestId);
    if (!pending) {
      await input.renderer.updateApprovalRequest({
        channelId: input.channelId,
        messageTs: input.messageTs,
        title: "Approval no longer active",
        text: "This approval request cannot be resolved from this Slack action.",
      });
      return;
    }

    if (pending.channelId !== input.channelId || (pending.messageTs != null && pending.messageTs !== input.messageTs)) {
      await input.renderer.updateApprovalRequest({
        channelId: input.channelId,
        messageTs: input.messageTs,
        title: "Approval action ignored",
        text: "This Slack action does not match the active approval request.",
      });
      return;
    }

    const approval = this.repos.resolveApprovalRequest({
      approvalRequestId: input.approvalRequestId,
      actorSlackUserId: input.actorSlackUserId,
      resolution: input.decision,
    });

    const title = input.decision === "approve" ? "Approval approved" : "Approval declined";
    if (!approval) {
      await input.renderer.updateApprovalRequest({
        channelId: input.channelId,
        messageTs: input.messageTs,
        title: "Approval already resolved",
        text: "This approval request is no longer pending.",
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(input.approvalRequestId);
    pending.resolve(serverApprovalResponse(pending.request, input.decision));

    await input.renderer.updateApprovalRequest({
      channelId: input.channelId,
      messageTs: input.messageTs,
      title,
      text: approvalSummaryText(approval.requestMethod, approval.command, approval.cwd),
    });
  }

  private async recordAndRequestApproval(request: CodexServerRequest): Promise<unknown | undefined> {
    const params = request.params;
    const codexThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!codexThreadId) return undefined;

    const session = this.repos.findSessionByCodexThreadId(codexThreadId);
    if (!session) return undefined;
    const activeSlackTurn = this.activeSlackTurns.get(session.id);
    if (!activeSlackTurn) {
      this.recordDeniedApproval(request, session, "No active Slack turn for approval request");
      return serverApprovalResponse(request, "decline");
    }

    const approval = this.repos.recordPendingApproval({
      sessionId: session.id,
      turnId: session.activeTurnId,
      codexRequestId: getRequestId(request),
      requestMethod: request.method,
      codexItemId: typeof params?.itemId === "string" ? params.itemId : null,
      codexApprovalId: typeof params?.approvalId === "string" ? params.approvalId : null,
      actionType: request.method,
      command: typeof params?.command === "string" ? params.command : null,
      cwd: typeof params?.cwd === "string" ? params.cwd : null,
    });

    const responsePromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const resolved = this.repos.resolveApprovalRequest({
          approvalRequestId: approval.id,
          actorSlackUserId: "system",
          resolution: "decline",
        });
        const pending = this.pendingApprovals.get(approval.id);
        this.pendingApprovals.delete(approval.id);
        if (resolved && pending?.messageTs) {
          void activeSlackTurn.renderer.updateApprovalRequest({
            channelId: activeSlackTurn.channelId,
            messageTs: pending.messageTs,
            title: "Approval timed out",
            text: approvalSummaryText(request.method, approval.command, approval.cwd),
          });
        }
        resolve(serverApprovalResponse(request, "decline"));
      }, APPROVAL_TIMEOUT_MS);
      timeout.unref?.();

      this.pendingApprovals.set(approval.id, {
        request,
        channelId: activeSlackTurn.channelId,
        messageTs: null,
        timeout,
        resolve,
      });
    });

    try {
      const posted = await activeSlackTurn.renderer.postApprovalRequest({
        channelId: activeSlackTurn.channelId,
        threadTs: activeSlackTurn.threadTs,
        approvalRequestId: approval.id,
        title: "Codex approval requested",
        text: approvalSummaryText(request.method, approval.command, approval.cwd),
      });
      const pending = this.pendingApprovals.get(approval.id);
      if (pending) pending.messageTs = posted.messageTs;
      if (posted.messageTs) {
        this.repos.setApprovalSlackMessage({
          approvalRequestId: approval.id,
          slackMessageTs: posted.messageTs,
        });
      }
    } catch (error) {
      this.logger.debug("approval request post failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      const pending = this.pendingApprovals.get(approval.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(approval.id);
        this.repos.resolveApprovalRequest({
          approvalRequestId: approval.id,
          actorSlackUserId: "system",
          resolution: "decline",
        });
        pending.resolve(serverApprovalResponse(request, "decline"));
      }
    }

    return await responsePromise;
  }

  private recordDeniedApproval(request: CodexServerRequest, session: AgentSession, reason: string): void {
    const params = request.params;
    this.repos.recordDeniedApproval({
      sessionId: session.id,
      turnId: session.activeTurnId,
      codexRequestId: getRequestId(request),
      requestMethod: request.method,
      codexItemId: typeof params?.itemId === "string" ? params.itemId : null,
      codexApprovalId: typeof params?.approvalId === "string" ? params.approvalId : null,
      actionType: request.method,
      command: typeof params?.command === "string" ? params.command : null,
      cwd: typeof params?.cwd === "string" ? params.cwd : null,
      reason,
    });
  }
}

function extractTurnId(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn;
  if (turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string") {
    return turn.id;
  }
  return null;
}

function formatFinalText(result: {
  status: string;
  text: string;
  errorMessage?: string;
}, referenceId: string): string {
  if (result.status === "interrupted") {
    return result.text.trim() || "Codex turn was interrupted.";
  }
  if (result.status === "failed") {
    return failureMessage(referenceId);
  }
  return result.text.trim() || "Codex returned an empty response.";
}

function shouldFetchThreadContext(input: SlackInput, session: AgentSession): boolean {
  if (input.threadTs === input.messageTs) return false;
  if (input.source !== "app_mention" && input.source !== "channel_thread") return false;
  if (session.codexThreadId) return false;
  return session.activeGeneration === 0;
}

function failureMessage(referenceId: string): string {
  return `Codex turn failed. Reference: ${referenceId}.`;
}

function serverApprovalResponse(request: CodexServerRequest, decision: ApprovalResolution): unknown {
  if (decision === "approve") {
    if (request.method === "item/permissions/requestApproval") {
      return {
        permissions: recordOrEmpty(request.params?.permissions),
        scope: "turn",
      };
    }
    return { decision: "accept" };
  }

  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  return { decision: "decline" };
}

function approvalSummaryText(method: string, command: string | null, cwd: string | null): string {
  const lines = [`Request: ${method}`];
  if (cwd) lines.push(`cwd: ${cwd}`);
  if (command) lines.push(`command: ${command.slice(0, 1500)}`);
  return lines.join("\n");
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
