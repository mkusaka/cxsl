import test from "node:test";
import assert from "node:assert/strict";
import {
  SLACK_MARKDOWN_TEXT_CHUNK_LIMIT,
  SlackRenderer,
  splitSlackMarkdown,
  type SlackWebClientPort,
} from "../src/slack/renderer.ts";

function createLogger() {
  return {
    debug() {},
  };
}

function createClient() {
  type PostedMessage = Parameters<SlackWebClientPort["chat"]["postMessage"]>[0];
  type UpdatedMessage = Parameters<NonNullable<SlackWebClientPort["chat"]["update"]>>[0];
  type StartedStream = Parameters<NonNullable<SlackWebClientPort["chat"]["startStream"]>>[0];
  type AppendedStream = Parameters<NonNullable<SlackWebClientPort["chat"]["appendStream"]>>[0];
  type StoppedStream = Parameters<NonNullable<SlackWebClientPort["chat"]["stopStream"]>>[0];
  type PostedEphemeral = Parameters<SlackWebClientPort["chat"]["postEphemeral"]>[0];
  const calls: PostedMessage[] = [];
  const updates: UpdatedMessage[] = [];
  const startedStreams: StartedStream[] = [];
  const appendedStreams: AppendedStream[] = [];
  const stoppedStreams: StoppedStream[] = [];
  const ephemeralCalls: PostedEphemeral[] = [];
  const client: SlackWebClientPort & {
    calls: PostedMessage[];
    updates: UpdatedMessage[];
    startedStreams: StartedStream[];
    appendedStreams: AppendedStream[];
    stoppedStreams: StoppedStream[];
    ephemeralCalls: PostedEphemeral[];
  } = {
    calls,
    updates,
    startedStreams,
    appendedStreams,
    stoppedStreams,
    ephemeralCalls,
    assistant: {
      threads: {
        async setStatus() {},
      },
    },
    chat: {
      async postMessage(payload: PostedMessage) {
        calls.push(payload);
        return { ok: true, ts: `1710000000.${String(calls.length).padStart(6, "0")}` };
      },
      async update(payload: UpdatedMessage) {
        updates.push(payload);
        return { ok: true };
      },
      async postEphemeral(payload: PostedEphemeral) {
        ephemeralCalls.push(payload);
        return { ok: true };
      },
      async startStream(payload: StartedStream) {
        startedStreams.push(payload);
        return { ok: true, ts: "1710000000.999999" };
      },
      async appendStream(payload: AppendedStream) {
        appendedStreams.push(payload);
        return { ok: true };
      },
      async stopStream(payload: StoppedStream) {
        stoppedStreams.push(payload);
        return { ok: true };
      },
    },
  };
  return client;
}

function getFirstPost(calls: ReturnType<typeof createClient>["calls"]) {
  const first = calls[0];
  assert.ok(first);
  return first;
}

test("postThreadMessage sends standard markdown through markdown_text", async () => {
  const client = createClient();
  const renderer = new SlackRenderer(client, createLogger());

  await renderer.postThreadMessage({
    channelId: "D123",
    threadTs: "1710000000.000001",
    text: "## Title\n\n**Bold** and `code`.",
  });

  assert.deepEqual(client.calls, [
    {
      channel: "D123",
      thread_ts: "1710000000.000001",
      markdown_text: "## Title\n\n**Bold** and `code`.",
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
  assert.equal("text" in getFirstPost(client.calls), false);
});

test("postEphemeralMessage sends markdown only to the target user", async () => {
  const client = createClient();
  const renderer = new SlackRenderer(client, createLogger());

  await renderer.postEphemeralMessage({
    channelId: "C123",
    userId: "U123",
    threadTs: "1710000000.000001",
    text: "This Slack user is not allowed to use cxsl.",
  });

  assert.deepEqual(client.ephemeralCalls, [
    {
      channel: "C123",
      user: "U123",
      thread_ts: "1710000000.000001",
      markdown_text: "This Slack user is not allowed to use cxsl.",
    },
  ]);
});

test("streams thread messages through Slack streaming APIs", async () => {
  const client = createClient();
  const renderer = new SlackRenderer(client, createLogger());

  const stream = await renderer.startThreadStream({
    teamId: "T123",
    channelId: "C123",
    threadTs: "1710000000.000001",
    userId: "U123",
  });
  assert.deepEqual(stream, { streamTs: "1710000000.999999" });
  await renderer.appendThreadStream({
    channelId: "C123",
    streamTs: "1710000000.999999",
    text: "Hello",
  });
  await renderer.stopThreadStream({
    channelId: "C123",
    streamTs: "1710000000.999999",
  });

  assert.deepEqual(client.startedStreams, [
    {
      channel: "C123",
      thread_ts: "1710000000.000001",
      recipient_team_id: "T123",
      recipient_user_id: "U123",
      markdown_text: "",
    },
  ]);
  assert.deepEqual(client.appendedStreams, [
    {
      channel: "C123",
      ts: "1710000000.999999",
      markdown_text: "Hello",
    },
  ]);
  assert.deepEqual(client.stoppedStreams, [
    {
      channel: "C123",
      ts: "1710000000.999999",
      markdown_text: undefined,
    },
  ]);
});

test("postApprovalRequest sends approve and decline buttons", async () => {
  const client = createClient();
  const renderer = new SlackRenderer(client, createLogger());

  const response = await renderer.postApprovalRequest({
    channelId: "C123",
    threadTs: "1710000000.000001",
    approvalRequestId: "approval-1",
    title: "Codex approval requested",
    text: "Request: item/commandExecution/requestApproval\ncommand: pnpm test",
  });

  assert.deepEqual(response, { messageTs: "1710000000.000001" });
  const message = getFirstPost(client.calls);
  assert.equal("blocks" in message, true);
  if (!("blocks" in message)) throw new Error("expected blocks");
  assert.deepEqual(message.blocks.at(1), {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        action_id: "cxsl_approval_approve",
        value: "approval-1",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Decline" },
        style: "danger",
        action_id: "cxsl_approval_decline",
        value: "approval-1",
      },
    ],
  });
});

test("splitSlackMarkdown keeps chunks below the Slack markdown_text limit", () => {
  const markdown = [
    "Intro",
    "a".repeat(SLACK_MARKDOWN_TEXT_CHUNK_LIMIT),
    "b".repeat(SLACK_MARKDOWN_TEXT_CHUNK_LIMIT),
  ].join("\n");

  const chunks = splitSlackMarkdown(markdown);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= SLACK_MARKDOWN_TEXT_CHUNK_LIMIT));
  assert.equal(chunks.join(""), markdown);
});

test("splitSlackMarkdown balances code fences across chunk boundaries", () => {
  const markdown = [
    "```ts",
    "const value = 1;",
    "const other = 2;",
    "```",
  ].join("\n");

  const chunks = splitSlackMarkdown(markdown, 30);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 30));
  for (const chunk of chunks) {
    const fenceCount = chunk.match(/```/g)?.length ?? 0;
    assert.equal(fenceCount % 2, 0);
  }
});
