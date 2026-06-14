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
  type PostedEphemeral = Parameters<SlackWebClientPort["chat"]["postEphemeral"]>[0];
  const calls: PostedMessage[] = [];
  const ephemeralCalls: PostedEphemeral[] = [];
  const client: SlackWebClientPort & {
    calls: PostedMessage[];
    ephemeralCalls: PostedEphemeral[];
  } = {
    calls,
    ephemeralCalls,
    assistant: {
      threads: {
        async setStatus() {},
      },
    },
    chat: {
      async postMessage(payload: PostedMessage) {
        calls.push(payload);
        return { ok: true };
      },
      async postEphemeral(payload: PostedEphemeral) {
        ephemeralCalls.push(payload);
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
