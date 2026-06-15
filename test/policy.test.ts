import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowed, SlackPolicyError } from "../src/orchestrator/policy.ts";
import {
  appMentionToInput,
  channelThreadMessageToInput,
  handleSlackInputWithPolicyFeedback,
  messageEventToInput,
} from "../src/slack/bolt.ts";
import { shouldIgnoreMessage, stripBotMentions, type SlackInput } from "../src/slack/input.ts";
import { SlackRenderer, type SlackWebClientPort } from "../src/slack/renderer.ts";
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
    (error) => {
      assert.ok(error instanceof SlackPolicyError);
      assert.equal(error.reason, "user");
      assert.match(error.message, /Slack user is not allowed/);
      return true;
    },
  );
});

test("policy rejects channels outside SLACK_ALLOWED_CHANNEL_IDS", () => {
  assert.throws(
    () => assertAllowed(config({ allowedChannelIds: new Set(["C999"]) }), input({ channelId: "C123" })),
    /Slack channel is not allowed/,
  );
});

test("handleSlackInputWithPolicyFeedback posts policy errors as ephemeral messages", async () => {
  type PostedMessage = Parameters<SlackWebClientPort["chat"]["postMessage"]>[0];
  type PostedEphemeral = Parameters<SlackWebClientPort["chat"]["postEphemeral"]>[0];
  const messageCalls: PostedMessage[] = [];
  const ephemeralCalls: PostedEphemeral[] = [];
  const client: SlackWebClientPort = {
    assistant: {
      threads: {
        async setStatus() {},
      },
    },
    chat: {
      async postMessage(payload: PostedMessage) {
        messageCalls.push(payload);
        return { ok: true };
      },
      async postEphemeral(payload: PostedEphemeral) {
        ephemeralCalls.push(payload);
        return { ok: true };
      },
    },
  };
  const renderer = new SlackRenderer(client, { debug() {} });
  const slackInput = input({ source: "app_mention", channelId: "C123", userId: "U123" });

  await handleSlackInputWithPolicyFeedback(
    {
      async handleSlackInput() {
        throw new SlackPolicyError("user", "This Slack user is not allowed to use cxsl.");
      },
    },
    slackInput,
    renderer,
    { debug() {} },
    true,
  );

  assert.deepEqual(messageCalls, []);
  assert.deepEqual(ephemeralCalls, [
    {
      channel: "C123",
      user: "U123",
      thread_ts: "1710000000.000001",
      markdown_text: "This Slack user is not allowed to use cxsl.",
    },
  ]);
});

test("handleSlackInputWithPolicyFeedback can suppress policy error notifications", async () => {
  type PostedEphemeral = Parameters<SlackWebClientPort["chat"]["postEphemeral"]>[0];
  const ephemeralCalls: PostedEphemeral[] = [];
  const client: SlackWebClientPort = {
    assistant: {
      threads: {
        async setStatus() {},
      },
    },
    chat: {
      async postMessage() {
        return { ok: true };
      },
      async postEphemeral(payload: PostedEphemeral) {
        ephemeralCalls.push(payload);
        return { ok: true };
      },
    },
  };
  const renderer = new SlackRenderer(client, { debug() {} });

  await handleSlackInputWithPolicyFeedback(
    {
      async handleSlackInput() {
        throw new SlackPolicyError("user", "This Slack user is not allowed to use cxsl.");
      },
    },
    input({ source: "channel_thread", channelId: "C123", userId: "U123" }),
    renderer,
    { debug() {} },
    false,
  );

  assert.deepEqual(ephemeralCalls, []);
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

test("channelThreadMessageToInput accepts unmentioned channel thread replies", () => {
  const input = channelThreadMessageToInput(
    {
      type: "message",
      channel_type: "channel",
      team: "T123",
      channel: "C123",
      user: "U123",
      text: "continue this",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
    },
    { botUserId: "UBOT", teamId: "T123" },
    config(),
  );

  assert.deepEqual(input, {
    source: "channel_thread",
    teamId: "T123",
    channelId: "C123",
    threadTs: "1710000000.000001",
    messageTs: "1710000001.000001",
    userId: "U123",
    text: "continue this",
  });
});

test("messageEventToInput routes unmentioned channel thread replies", () => {
  const input = messageEventToInput(
    {
      type: "message",
      channel_type: "channel",
      team: "T123",
      channel: "C123",
      user: "U123",
      text: "continue this",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
    },
    { botUserId: "UBOT", teamId: "T123" },
    config(),
  );

  assert.deepEqual(input, {
    source: "channel_thread",
    teamId: "T123",
    channelId: "C123",
    threadTs: "1710000000.000001",
    messageTs: "1710000001.000001",
    userId: "U123",
    text: "continue this",
  });
});

test("messageEventToInput uses context team for channel thread messages without event team", () => {
  const input = messageEventToInput(
    {
      type: "message",
      channel_type: "channel",
      channel: "C123",
      user: "U123",
      text: "continue this",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
    },
    { botUserId: "UBOT", teamId: "T123" },
    config(),
  );

  assert.equal(input?.teamId, "T123");
  assert.equal(input?.source, "channel_thread");
});

test("messageEventToInput routes unmentioned private channel thread replies", () => {
  const input = messageEventToInput(
    {
      type: "message",
      channel_type: "group",
      team: "T123",
      channel: "G123",
      user: "U123",
      text: "continue this privately",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
    },
    { botUserId: "UBOT", teamId: "T123" },
    config(),
  );

  assert.deepEqual(input, {
    source: "channel_thread",
    teamId: "T123",
    channelId: "G123",
    threadTs: "1710000000.000001",
    messageTs: "1710000001.000001",
    userId: "U123",
    text: "continue this privately",
  });
});

test("channelThreadMessageToInput accepts any user when allowlists are unset", () => {
  const input = channelThreadMessageToInput(
    {
      type: "message",
      team: "T123",
      channel: "C999",
      user: "U999",
      text: "continue this",
      ts: "1710000001.000001",
      thread_ts: "1710000000.000001",
    },
    { botUserId: "UBOT", teamId: "T123" },
    config(),
  );

  assert.equal(input?.source, "channel_thread");
  assert.equal(input?.channelId, "C999");
  assert.equal(input?.userId, "U999");
});

test("channelThreadMessageToInput ignores root messages and aside notes", () => {
  assert.equal(
    channelThreadMessageToInput(
      {
        type: "message",
        channel_type: "channel",
        team: "T123",
        channel: "C123",
        user: "U123",
        text: "root",
        ts: "1710000000.000001",
      },
      { botUserId: "UBOT", teamId: "T123" },
      config(),
    ),
    null,
  );

  assert.equal(
    channelThreadMessageToInput(
      {
        type: "message",
        channel_type: "channel",
        team: "T123",
        channel: "C123",
        user: "U123",
        text: "  !aside this is not for Codex",
        ts: "1710000001.000001",
        thread_ts: "1710000000.000001",
      },
      { botUserId: "UBOT", teamId: "T123" },
      config(),
    ),
    null,
  );
});

test("channelThreadMessageToInput leaves mentioned messages to app_mention handling", () => {
  assert.equal(
    channelThreadMessageToInput(
      {
        type: "message",
        channel_type: "channel",
        team: "T123",
        channel: "C123",
        user: "U123",
        text: "<@UBOT> !aside handle this",
        ts: "1710000001.000001",
        thread_ts: "1710000000.000001",
      },
      { botUserId: "UBOT", teamId: "T123" },
      config(),
    ),
    null,
  );
  assert.equal(stripBotMentions("<@UBOT> !aside handle this"), "!aside handle this");
});

test("appMentionToInput accepts mentioned aside notes", () => {
  assert.deepEqual(
    appMentionToInput(
      {
        type: "app_mention",
        team: "T123",
        channel: "C123",
        user: "U123",
        text: "<@UBOT> !aside handle this",
        ts: "1710000001.000001",
        thread_ts: "1710000000.000001",
      },
      { botUserId: "UBOT", teamId: "T123" },
    ),
    {
      source: "app_mention",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1710000000.000001",
      messageTs: "1710000001.000001",
      userId: "U123",
      text: "!aside handle this",
    },
  );
});

test("channelThreadMessageToInput honors user and channel allowlists", () => {
  const allowedConfig = config({
    allowedUserIds: new Set(["U123"]),
    allowedChannelIds: new Set(["C123"]),
  });
  const baseMessage = {
    type: "message",
    channel_type: "channel",
    team: "T123",
    channel: "C123",
    user: "U123",
    text: "continue this",
    ts: "1710000001.000001",
    thread_ts: "1710000000.000001",
  };
  const context = { botUserId: "UBOT", teamId: "T123" };

  assert.equal(
    channelThreadMessageToInput(baseMessage, context, allowedConfig)?.source,
    "channel_thread",
  );
  assert.equal(
    channelThreadMessageToInput(
      { ...baseMessage, user: "U999" },
      context,
      allowedConfig,
    ),
    null,
  );
  assert.equal(
    channelThreadMessageToInput(
      { ...baseMessage, channel: "C999" },
      context,
      allowedConfig,
    ),
    null,
  );
});
