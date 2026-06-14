import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db/database.ts";
import { Repositories } from "../src/db/repositories.ts";

const FAKE_SLACK_BOT_TOKEN = "xox" + "b-secret-value";

function createRepos(): { repos: Repositories; db: DatabaseSync } {
  const db = openDatabase(":memory:");
  return { repos: new Repositories(db), db };
}

function createSession(repos: Repositories) {
  const slackThread = repos.resolveSlackThread({
    teamId: "T123",
    channelId: "D123",
    threadTs: "1710000000.000001",
    userId: "U123",
  });
  return repos.resolveSession({
    slackThreadId: slackThread.id,
    userId: "U123",
    approvalPolicy: "on-request",
    sandboxPolicy: "workspace-write",
  });
}

test("createTurn claims a session once while it is running", () => {
  const { repos } = createRepos();
  const session = createSession(repos);

  const firstTurn = repos.createTurn({
    sessionId: session.id,
    generation: 1,
    inputText: "first",
    classifiedIntent: "start_turn",
  });
  const secondTurn = repos.createTurn({
    sessionId: session.id,
    generation: 2,
    inputText: "second",
    classifiedIntent: "start_turn",
  });

  assert.ok(firstTurn);
  assert.equal(secondTurn, null);
  assert.equal(createSession(repos).state, "running");
});

test("completeTurn only clears the active turn it owns", () => {
  const { repos } = createRepos();
  const session = createSession(repos);
  const turn = repos.createTurn({
    sessionId: session.id,
    generation: 1,
    inputText: "first",
    classifiedIntent: "start_turn",
  });
  assert.ok(turn);

  repos.completeTurn({
    sessionId: session.id,
    turnId: "other-turn",
    state: "completed",
  });
  assert.equal(createSession(repos).state, "running");

  repos.completeTurn({
    sessionId: session.id,
    turnId: turn.id,
    state: "completed",
  });
  assert.equal(createSession(repos).state, "idle");
});

test("free-form persisted text is redacted", () => {
  const { repos, db } = createRepos();
  const session = createSession(repos);
  const turn = repos.createTurn({
    sessionId: session.id,
    generation: 1,
    inputText: `inspect SLACK_BOT_TOKEN=${FAKE_SLACK_BOT_TOKEN}`,
    classifiedIntent: "start_turn",
  });
  assert.ok(turn);

  repos.completeTurn({
    sessionId: session.id,
    turnId: turn.id,
    state: "failed",
    errorMessage: "failed with OPENAI_API_KEY=sk-secret-secret-secret-secret",
  });

  const row = db.prepare("SELECT input_preview, error_message FROM agent_turns WHERE id = ?").get(turn.id);
  assert.ok(row);
  const inputPreview = row.input_preview;
  const errorMessage = row.error_message;
  assert.equal(typeof inputPreview, "string");
  assert.equal(typeof errorMessage, "string");

  assert.equal(inputPreview.includes(FAKE_SLACK_BOT_TOKEN), false);
  assert.doesNotMatch(errorMessage, /sk-secret/);
  assert.match(inputPreview, /<redacted>/);
  assert.match(errorMessage, /<redacted>/);
});
