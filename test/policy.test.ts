import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowed } from "../src/orchestrator/policy.ts";
import { shouldIgnoreMessage, stripBotMentions, type SlackInput } from "../src/slack/input.ts";
import type { AppConfig } from "../src/config.ts";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slackBotToken: "xoxb-redacted",
    slackAppToken: "xapp-redacted",
    databasePath: ".data/test.sqlite",
    codexCommand: "codex",
    codexArgs: ["app-server"],
    codexDefaultCwd: ".",
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
    teamId: "TOTHER",
    channelId: "D123",
    threadTs: "1710000000.000001",
    messageTs: "1710000000.000001",
    userId: "U123",
    text: "hello",
    ...overrides,
  };
}

test("policy does not restrict by Slack team", () => {
  assert.doesNotThrow(() => {
    assertAllowed(config({ allowedUserIds: new Set(["U123"]) }), input({ teamId: "TDIFFERENT" }));
  });
});

test("policy rejects users outside SLACK_ALLOWED_USER_IDS", () => {
  assert.throws(
    () => assertAllowed(config({ allowedUserIds: new Set(["U999"]) }), input({ userId: "U123" })),
    /Slack user is not allowed/,
  );
});

test("policy rejects channels outside SLACK_ALLOWED_CHANNEL_IDS", () => {
  assert.throws(
    () => assertAllowed(config({ allowedChannelIds: new Set(["C999"]) }), input({ channelId: "C123" })),
    /Slack channel is not allowed/,
  );
});

test("stripBotMentions removes Slack bot mentions and normalizes whitespace", () => {
  assert.equal(stripBotMentions("<@U999>   inspect this  <@U888>"), "inspect this");
});

test("shouldIgnoreMessage ignores bot, subtype, and missing-user messages", () => {
  assert.equal(shouldIgnoreMessage({ user: "U123", text: "ok" }), false);
  assert.equal(shouldIgnoreMessage({ user: "U123", subtype: "message_changed" }), true);
  assert.equal(shouldIgnoreMessage({ user: "U123", bot_id: "B123" }), true);
  assert.equal(shouldIgnoreMessage({ text: "ok" }), true);
});
