import test from "node:test";
import assert from "node:assert/strict";
import type { CodexServerRequest, TurnRunResult } from "../src/codex/protocol.ts";
import type { AppConfig } from "../src/config.ts";
import type {
  AgentSession,
  AgentTurn,
  ApprovalRequest,
  SlackThread,
} from "../src/db/repositories.ts";
import type { Logger } from "../src/logger.ts";
import {
  Orchestrator,
  type OrchestratorCodexClient,
  type OrchestratorRepositories,
  type SlackOutput,
} from "../src/orchestrator/orchestrator.ts";
import type { SlackInput } from "../src/slack/input.ts";

const FAKE_SLACK_BOT_TOKEN = "xox" + "b-redacted";
const FAKE_SLACK_APP_TOKEN = "xap" + "p-redacted";
const FAKE_SECRET_SLACK_BOT_TOKEN = "xox" + "b-secret-value";
const FAKE_SECRET_SLACK_APP_TOKEN = "xap" + "p-secret-value";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slackBotToken: FAKE_SLACK_BOT_TOKEN,
    slackAppToken: FAKE_SLACK_APP_TOKEN,
    databasePath: ".data/test.sqlite",
    codexCommand: "codex",
    codexArgs: ["app-server"],
    codexDefaultCwd: "/tmp/cxsl-test",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    allowedUserIds: new Set(),
    allowedChannelIds: new Set(),
    logLevel: "error",
    ...overrides,
  };
}

function input(overrides: Partial<SlackInput> = {}): SlackInput {
  return {
    source: "dm",
    teamId: "T123",
    channelId: "D123",
    threadTs: "1710000000.000001",
    messageTs: "1710000000.000001",
    userId: "U123",
    text: "Inspect this repo",
    ...overrides,
  };
}

type TestLogger = Pick<Logger, "debug" | "error"> & {
  errors: Record<string, unknown>[];
};

function createLogger(): TestLogger {
  const errors: Record<string, unknown>[] = [];
  return {
    errors,
    debug() {},
    error(_message: string, fields: Record<string, unknown> = {}) {
      errors.push(fields);
    },
  };
}

type StartThreadInput = Parameters<OrchestratorCodexClient["startThread"]>[0];
type RunTurnInput = Parameters<OrchestratorCodexClient["runTurn"]>[0];
type NotificationHandler = Parameters<OrchestratorCodexClient["onNotification"]>[0];
type ServerRequestHandler = Parameters<OrchestratorCodexClient["onServerRequest"]>[0];

type TestCodex = OrchestratorCodexClient & {
  startedThreads: StartThreadInput[];
  resumedThreads: string[];
  turns: RunTurnInput[];
  notificationHandlers: NotificationHandler[];
  serverRequestHandlers: ServerRequestHandler[];
  runTurn: OrchestratorCodexClient["runTurn"];
};

function createCodex(
  result: TurnRunResult = {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    text: "Done",
  },
): TestCodex {
  const startedThreads: StartThreadInput[] = [];
  const resumedThreads: string[] = [];
  const turns: RunTurnInput[] = [];
  const notificationHandlers: NotificationHandler[] = [];
  const serverRequestHandlers: ServerRequestHandler[] = [];
  return {
    startedThreads,
    resumedThreads,
    turns,
    notificationHandlers,
    serverRequestHandlers,
    onNotification(handler: NotificationHandler) {
      notificationHandlers.push(handler);
    },
    onServerRequest(handler: ServerRequestHandler) {
      serverRequestHandlers.push(handler);
    },
    async startThread(payload: StartThreadInput) {
      startedThreads.push(payload);
      return { threadId: "thread-1" };
    },
    async resumeThread(threadId: string) {
      resumedThreads.push(threadId);
    },
    async runTurn(payload: RunTurnInput) {
      turns.push(payload);
      return result;
    },
  };
}

type SetStatusInput = Parameters<SlackOutput["setAssistantStatus"]>[0];
type PostMessageInput = Parameters<SlackOutput["postThreadMessage"]>[0];
type AppendStreamInput = Parameters<SlackOutput["appendThreadStream"]>[0];
type StopStreamInput = Parameters<SlackOutput["stopThreadStream"]>[0];
type ApprovalPostInput = Parameters<SlackOutput["postApprovalRequest"]>[0];
type ApprovalUpdateInput = Parameters<SlackOutput["updateApprovalRequest"]>[0];

function createRenderer(): SlackOutput & {
  statuses: SetStatusInput[];
  messages: PostMessageInput[];
  streamStarts: { channelId: string; threadTs: string }[];
  streamAppends: AppendStreamInput[];
  streamStops: StopStreamInput[];
  approvals: (ApprovalPostInput & { messageTs: string })[];
  approvalUpdates: ApprovalUpdateInput[];
} {
  const statuses: SetStatusInput[] = [];
  const messages: PostMessageInput[] = [];
  const streamStarts: { channelId: string; threadTs: string }[] = [];
  const streamAppends: AppendStreamInput[] = [];
  const streamStops: StopStreamInput[] = [];
  const approvals: (ApprovalPostInput & { messageTs: string })[] = [];
  const approvalUpdates: ApprovalUpdateInput[] = [];
  return {
    statuses,
    messages,
    streamStarts,
    streamAppends,
    streamStops,
    approvals,
    approvalUpdates,
    async setAssistantStatus(payload: SetStatusInput) {
      statuses.push(payload);
    },
    async postThreadMessage(payload: PostMessageInput) {
      messages.push(payload);
    },
    async startThreadStream(payload) {
      streamStarts.push(payload);
      return { streamTs: "stream-1" };
    },
    async appendThreadStream(payload: AppendStreamInput) {
      streamAppends.push(payload);
    },
    async stopThreadStream(payload: StopStreamInput) {
      streamStops.push(payload);
    },
    async postApprovalRequest(payload: ApprovalPostInput) {
      const messageTs = `approval-message-${approvals.length + 1}`;
      approvals.push({ ...payload, messageTs });
      return { messageTs };
    },
    async updateApprovalRequest(payload: ApprovalUpdateInput) {
      approvalUpdates.push(payload);
    },
  };
}

type CreateTurnInput = Parameters<OrchestratorRepositories["createTurn"]>[0];
type CompleteTurnInput = Parameters<OrchestratorRepositories["completeTurn"]>[0];
type BoundThread = { sessionId: string; threadId: string };
type BoundTurn = { turnId: string; codexTurnId: string };

type TestRepos = OrchestratorRepositories & {
  session: AgentSession;
  turns: CreateTurnInput[];
  completions: CompleteTurnInput[];
  boundThreads: BoundThread[];
  boundTurns: BoundTurn[];
  approvals: ApprovalRequest[];
  createTurn: OrchestratorRepositories["createTurn"];
};

function createRepos(sessionOverrides: Partial<AgentSession> = {}): TestRepos {
  const session: AgentSession = {
    id: "session-1",
    slackThreadId: "slack-thread-1",
    codexThreadId: null,
    state: "idle",
    activeTurnId: null,
    activeGeneration: 0,
    model: null,
    approvalPolicy: "on-request",
    sandboxPolicy: "workspace-write",
    createdBySlackUserId: "U123",
    ...sessionOverrides,
  };
  const turns: CreateTurnInput[] = [];
  const completions: CompleteTurnInput[] = [];
  const boundThreads: BoundThread[] = [];
  const boundTurns: BoundTurn[] = [];
  const approvals: ApprovalRequest[] = [];
  return {
    session,
    turns,
    completions,
    boundThreads,
    boundTurns,
    approvals,
    resolveSlackThread(input): SlackThread {
      return {
        id: "slack-thread-1",
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        userId: input.userId,
      };
    },
    resolveSession() {
      return session;
    },
    createTurn(payload: CreateTurnInput): AgentTurn | null {
      turns.push(payload);
      session.activeTurnId = "turn-row-1";
      session.activeGeneration = payload.generation;
      session.state = "running";
      return {
        id: "turn-row-1",
        sessionId: payload.sessionId,
        codexTurnId: null,
        generation: payload.generation,
        state: "running",
      };
    },
    bindCodexThread(sessionId: string, threadId: string) {
      boundThreads.push({ sessionId, threadId });
      session.codexThreadId = threadId;
    },
    bindCodexTurn(turnId: string, codexTurnId: string) {
      boundTurns.push({ turnId, codexTurnId });
    },
    completeTurn(payload: CompleteTurnInput) {
      completions.push(payload);
      session.activeTurnId = null;
      session.state = payload.state === "completed" ? "idle" : payload.state;
    },
    findSessionByCodexThreadId() {
      return session.codexThreadId ? session : null;
    },
    recordCodexEvent() {},
    recordDeniedApproval() {},
    recordPendingApproval(payload) {
      const approval: ApprovalRequest = {
        id: `approval-${approvals.length + 1}`,
        sessionId: payload.sessionId,
        turnId: payload.turnId ?? null,
        codexRequestId: payload.codexRequestId,
        requestMethod: payload.requestMethod,
        codexItemId: payload.codexItemId ?? null,
        codexApprovalId: payload.codexApprovalId ?? null,
        slackMessageTs: null,
        actionType: payload.actionType,
        command: payload.command ?? null,
        cwd: payload.cwd ?? null,
        state: "requested",
        resolution: null,
      };
      approvals.push(approval);
      return approval;
    },
    setApprovalSlackMessage(payload) {
      const approval = approvals.find((entry) => entry.id === payload.approvalRequestId);
      if (approval) approval.slackMessageTs = payload.slackMessageTs;
    },
    resolveApprovalRequest(payload) {
      const approval = approvals.find((entry) => entry.id === payload.approvalRequestId);
      if (!approval || approval.state !== "requested") return null;
      approval.state = "resolved";
      approval.resolution = payload.resolution;
      return approval;
    },
  };
}

test("handleSlackInput sets and clears Slack status while Codex runs", async () => {
  const codex = createCodex();
  const repos = createRepos();
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input({ source: "app_mention", channelId: "C123" }), renderer);

  assert.deepEqual(renderer.statuses, [
    {
      channelId: "C123",
      threadTs: "1710000000.000001",
      status: "Thinking...",
      loadingMessages: ["Sending the request to Codex...", "Generating a response..."],
    },
    { channelId: "C123", threadTs: "1710000000.000001", status: "" },
  ]);
  assert.deepEqual(renderer.streamStarts, [{ channelId: "C123", threadTs: "1710000000.000001" }]);
  assert.deepEqual(renderer.streamStops, [{ channelId: "C123", streamTs: "stream-1", text: "Done" }]);
  assert.equal(renderer.messages.length, 0);
  assert.equal(codex.startedThreads.length, 1);
  assert.equal(codex.turns.length, 1);
});

test("handleSlackInput streams Codex deltas by default", async () => {
  const codex = createCodex();
  codex.runTurn = async (payload) => {
    codex.turns.push(payload);
    await payload.onDelta?.("Do");
    await payload.onDelta?.("ne");
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "Done",
    };
  };
  const repos = createRepos();
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input(), renderer);

  assert.deepEqual(renderer.streamAppends, [
    { channelId: "D123", streamTs: "stream-1", text: "Do" },
    { channelId: "D123", streamTs: "stream-1", text: "ne" },
  ]);
  assert.deepEqual(renderer.streamStops, [
    { channelId: "D123", streamTs: "stream-1", text: undefined },
  ]);
  assert.equal(renderer.messages.length, 0);
});

test("handleSlackInput resolves Codex approval requests from Slack buttons", async () => {
  const codex = createCodex();
  const repos = createRepos();
  const renderer = createRenderer();
  let orchestrator!: Orchestrator;

  codex.runTurn = async (payload) => {
    codex.turns.push(payload);
    const handler = codex.serverRequestHandlers[0];
    assert.ok(handler);
    const responsePromise = handler({
      id: "request-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        itemId: "item-1",
        approvalId: "approval-id-1",
        command: "pnpm test",
        cwd: "/tmp/cxsl-test",
      },
    } satisfies CodexServerRequest);

    for (let index = 0; index < 5 && renderer.approvals.length === 0; index += 1) {
      await Promise.resolve();
    }
    const approvalMessage = renderer.approvals[0];
    assert.ok(approvalMessage);

    await orchestrator.handleApprovalAction({
      approvalRequestId: approvalMessage.approvalRequestId,
      actorSlackUserId: "U123",
      decision: "approve",
      channelId: "D123",
      messageTs: approvalMessage.messageTs,
      renderer,
    });

    assert.deepEqual(await responsePromise, { decision: "accept" });
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "Done",
    };
  };

  orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input(), renderer);

  assert.equal(repos.approvals[0]?.state, "resolved");
  assert.equal(repos.approvals[0]?.resolution, "approve");
  assert.deepEqual(renderer.approvalUpdates, [
    {
      channelId: "D123",
      messageTs: "approval-message-1",
      title: "Approval approved",
      text: "Request: item/commandExecution/requestApproval\ncwd: /tmp/cxsl-test\ncommand: pnpm test",
    },
  ]);
});

test("handleSlackInput returns a generic Slack error for failed Codex results", async () => {
  const codex = createCodex({
    threadId: "thread-1",
    turnId: "turn-1",
    status: "failed",
    text: "",
    errorMessage: `failed with SLACK_BOT_TOKEN=${FAKE_SECRET_SLACK_BOT_TOKEN}`,
  });
  const repos = createRepos();
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input(), renderer);

  const message = renderer.streamStops.at(-1)?.text ?? "";
  assert.match(message, /^Codex turn failed\. Reference: turn-row-1\.$/);
  assert.equal(message.includes(FAKE_SECRET_SLACK_BOT_TOKEN), false);
});

test("handleSlackInput redacts thrown errors before logging and hides them from Slack", async () => {
  const codex = createCodex();
  codex.runTurn = async () => {
    throw new Error(`request failed with SLACK_APP_TOKEN=${FAKE_SECRET_SLACK_APP_TOKEN}`);
  };
  const repos = createRepos();
  const renderer = createRenderer();
  const logger = createLogger();
  const orchestrator = new Orchestrator(config(), repos, codex, logger);

  await orchestrator.handleSlackInput(input(), renderer);

  const message = renderer.streamStops.at(-1)?.text ?? "";
  assert.equal(message, "Codex turn failed. Reference: turn-row-1.");
  assert.equal(JSON.stringify(logger.errors).includes(FAKE_SECRET_SLACK_APP_TOKEN), false);
  assert.match(JSON.stringify(logger.errors), /<redacted>/);
});

test("handleSlackInput does not set status when the turn claim fails", async () => {
  const codex = createCodex();
  const repos = createRepos();
  repos.createTurn = () => null;
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input(), renderer);

  assert.equal(codex.turns.length, 0);
  assert.equal(renderer.statuses.length, 0);
  assert.equal(
    renderer.messages.at(-1)?.text,
    "Another Codex turn is already running in this Slack thread. Try again after it finishes.",
  );
});

test("handleSlackInput resumes an existing Codex thread", async () => {
  const codex = createCodex();
  const repos = createRepos({ codexThreadId: "thread-existing" });
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(config(), repos, codex, createLogger());

  await orchestrator.handleSlackInput(input(), renderer);

  assert.deepEqual(codex.resumedThreads, ["thread-existing"]);
  assert.equal(codex.startedThreads.length, 0);
});

test("handleSlackInput rejects disallowed users before calling Codex", async () => {
  const codex = createCodex();
  const repos = createRepos();
  const renderer = createRenderer();
  const orchestrator = new Orchestrator(
    config({ allowedUserIds: new Set(["U999"]) }),
    repos,
    codex,
    createLogger(),
  );

  await assert.rejects(() => orchestrator.handleSlackInput(input({ userId: "U123" }), renderer));
  assert.equal(codex.turns.length, 0);
  assert.equal(renderer.messages.length, 0);
});
