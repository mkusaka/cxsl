import test from "node:test";
import assert from "node:assert/strict";
import type { SlackWebClientPort } from "../src/slack/renderer.ts";
import { SlackThreadContextFetcher } from "../src/slack/thread-context.ts";

function createLogger() {
  return {
    debug() {},
    warn() {},
  };
}

function createClient(messages: unknown[]): SlackWebClientPort & {
  repliesCalls: unknown[];
  userInfoCalls: string[];
} {
  const repliesCalls: unknown[] = [];
  const userInfoCalls: string[] = [];
  return {
    repliesCalls,
    userInfoCalls,
    assistant: {
      threads: {
        async setStatus() {},
      },
    },
    conversations: {
      async replies(payload) {
        repliesCalls.push(payload);
        return { messages };
      },
    },
    users: {
      async info(payload) {
        userInfoCalls.push(payload.user);
        const names: Record<string, string> = {
          UALICE: "Alice",
          UBOB: "Bob",
          UOTHERBOT: "DeployBot",
        };
        return {
          user: {
            name: names[payload.user] ?? payload.user,
          },
        };
      },
    },
    chat: {
      async postMessage() {
        return { ok: true };
      },
      async postEphemeral() {
        return { ok: true };
      },
    },
  };
}

test("SlackThreadContextFetcher formats prior thread messages and excludes current trigger", async () => {
  const client = createClient([
    { ts: "1000.0", user: "UALICE", text: "This is the parent message" },
    { ts: "1000.1", user: "UBOB", text: "I think we should refactor" },
    { ts: "1000.2", user: "UALICE", text: "Good idea, <@UBOT> what do you think?" },
  ]);
  const fetcher = new SlackThreadContextFetcher(createLogger());

  const context = await fetcher.fetchThreadContext(client, {
    teamId: "T1",
    channelId: "C1",
    threadTs: "1000.0",
    currentTs: "1000.2",
    botUserId: "UBOT",
  });

  assert.match(context, /^\[Thread context/);
  assert.match(context, /\[thread parent\] Alice: This is the parent message/);
  assert.match(context, /Bob: I think we should refactor/);
  assert.equal(context.includes("what do you think"), false);
  assert.equal(context.includes("<@UBOT>"), false);
  assert.deepEqual(client.repliesCalls, [
    {
      channel: "C1",
      ts: "1000.0",
      limit: 31,
      inclusive: true,
    },
  ]);
});

test("SlackThreadContextFetcher skips self-bot child replies but keeps third-party bot context", async () => {
  const client = createClient([
    { ts: "1000.0", user: "UALICE", text: "Parent" },
    {
      ts: "1000.1",
      bot_id: "BSELF",
      user: "UBOT",
      text: "Previous self reply",
    },
    {
      ts: "1000.15",
      bot_id: "BOTHER",
      user: "UOTHERBOT",
      text: "Deploy succeeded",
    },
    { ts: "1000.2", user: "UALICE", text: "Current" },
  ]);
  const fetcher = new SlackThreadContextFetcher(createLogger());

  const context = await fetcher.fetchThreadContext(client, {
    teamId: "T1",
    channelId: "C1",
    threadTs: "1000.0",
    currentTs: "1000.2",
    botUserId: "UBOT",
  });

  assert.equal(context.includes("Previous self reply"), false);
  assert.match(context, /Alice: Parent/);
  assert.match(context, /DeployBot: Deploy succeeded/);
});

test("SlackThreadContextFetcher caches thread context briefly", async () => {
  const client = createClient([
    { ts: "1000.0", user: "UALICE", text: "Parent" },
    { ts: "1000.2", user: "UALICE", text: "Current" },
  ]);
  const fetcher = new SlackThreadContextFetcher(createLogger());
  const input = {
    teamId: "T1",
    channelId: "C1",
    threadTs: "1000.0",
    currentTs: "1000.2",
    botUserId: "UBOT",
  };

  const first = await fetcher.fetchThreadContext(client, input);
  const second = await fetcher.fetchThreadContext(client, input);

  assert.equal(first, second);
  assert.equal(client.repliesCalls.length, 1);
});
