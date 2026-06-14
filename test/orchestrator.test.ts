import test from "node:test";
import assert from "node:assert/strict";
import type { TurnRunResult } from "../src/codex/protocol.ts";
import type { AppConfig } from "../src/config.ts";
import type { AgentSession, AgentTurn, SlackThread } from "../src/db/repositories.ts";
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
    streamingEnabled: false,
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

type TestLogger = Pick<Logger, "error"> & {
  errors: Record<string, unknown>[];
};

function createLogger(): TestLogger {
  const errors: Record<string, unknown>[] = [];
  return {
    errors,
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
  return {
    startedThreads,
    resumedThreads,
    turns,
    onNotification(_handler: NotificationHandler) {},
    onServerRequest(_handler: ServerRequestHandler) {},
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

function createRenderer(): SlackOutput & {
  statuses: SetStatusInput[];
  messages: PostMessageInput[];
} {
  const statuses: SetStatusInput[] = [];
  const messages: PostMessageInput[] = [];
  return {
    statuses,
    messages,
    async setAssistantStatus(payload: SetStatusInput) {
      statuses.push(payload);
    },
    async postThreadMessage(payload: PostMessageInput) {
      messages.push(payload);
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
  return {
    session,
    turns,
    completions,
    boundThreads,
    boundTurns,
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
      return null;
    },
    recordCodexEvent() {},
    recordDeniedApproval() {},
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
  assert.equal(renderer.messages.at(-1)?.text, "Done");
  assert.equal(codex.startedThreads.length, 1);
  assert.equal(codex.turns.length, 1);
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

  const message = renderer.messages.at(-1)?.text ?? "";
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

  const message = renderer.messages.at(-1)?.text ?? "";
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
