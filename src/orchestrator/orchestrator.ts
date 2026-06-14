import type { AppConfig } from "../config.ts";
import { getRequestId, type CodexClient } from "../codex/client.ts";
import type { CodexNotification, CodexServerRequest } from "../codex/protocol.ts";
import type { Logger } from "../logger.ts";
import type { AgentSession, Repositories } from "../db/repositories.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import type { SlackInput } from "../slack/input.ts";
import type { SlackRenderer } from "../slack/renderer.ts";
import { assertAllowed } from "./policy.ts";

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
>;

export type OrchestratorCodexClient = Pick<
  CodexClient,
  | "onNotification"
  | "onServerRequest"
  | "startThread"
  | "resumeThread"
  | "runTurn"
>;

export type SlackOutput = Pick<SlackRenderer, "setAssistantStatus" | "postThreadMessage">;

export class Orchestrator {
  private readonly config: AppConfig;
  private readonly repos: OrchestratorRepositories;
  private readonly codex: OrchestratorCodexClient;
  private readonly logger: Pick<Logger, "error">;

  constructor(
    config: AppConfig,
    repos: OrchestratorRepositories,
    codex: OrchestratorCodexClient,
    logger: Pick<Logger, "error">,
  ) {
    this.config = config;
    this.repos = repos;
    this.codex = codex;
    this.logger = logger;
    this.codex.onNotification((notification) => this.recordCodexNotification(notification));
    this.codex.onServerRequest((request) => this.recordAndDeclineServerRequest(request));
  }

  async handleSlackInput(input: SlackInput, renderer: SlackOutput): Promise<void> {
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

    try {
      const codexThreadId = await this.ensureCodexThread(session);
      const result = await this.codex.runTurn({
        threadId: codexThreadId,
        text: input.text,
        cwd: this.config.codexDefaultCwd,
        clientUserMessageId: input.messageTs,
      });
      this.repos.bindCodexTurn(turn.id, result.turnId);

      const finalText = formatFinalText(result, turn.id);
      await renderer.postThreadMessage({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: finalText,
      });

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
      await renderer.postThreadMessage({
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: failureMessage(turn.id),
      });
    } finally {
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

  private async recordAndDeclineServerRequest(request: CodexServerRequest): Promise<unknown | undefined> {
    const params = request.params;
    const codexThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!codexThreadId) return undefined;

    const session = this.repos.findSessionByCodexThreadId(codexThreadId);
    if (!session) return undefined;

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
      reason: typeof params?.reason === "string" ? params.reason : null,
    });

    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      default:
        return undefined;
    }
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

function failureMessage(referenceId: string): string {
  return `Codex turn failed. Reference: ${referenceId}.`;
}
