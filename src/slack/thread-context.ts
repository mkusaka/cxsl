import type { Logger } from "../logger.ts";
import type { SlackConversationMessage, SlackUserInfo, SlackWebClientPort } from "./renderer.ts";

const THREAD_CONTEXT_LIMIT = 30;
const THREAD_CONTEXT_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  content: string;
  fetchedAt: number;
};

export type SlackThreadContextInput = {
  teamId: string;
  channelId: string;
  threadTs: string;
  currentTs: string;
  botUserId?: string;
};

export type SlackThreadContextProvider = {
  fetchThreadContext(input: SlackThreadContextInput): Promise<string>;
};

export class SlackThreadContextFetcher {
  private readonly logger: Pick<Logger, "debug" | "warn">;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly userNameCache = new Map<string, string>();

  constructor(logger: Pick<Logger, "debug" | "warn">) {
    this.logger = logger;
  }

  providerFor(client: SlackWebClientPort, botUserId: string | undefined): SlackThreadContextProvider {
    return {
      fetchThreadContext: (input) =>
        this.fetchThreadContext(client, {
          ...input,
          botUserId: input.botUserId ?? botUserId,
        }),
    };
  }

  async fetchThreadContext(
    client: SlackWebClientPort,
    input: SlackThreadContextInput,
  ): Promise<string> {
    const cacheKey = `${input.channelId}:${input.threadTs}:${input.teamId}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.fetchedAt < THREAD_CONTEXT_CACHE_TTL_MS) {
      return cached.content;
    }

    if (!client.conversations?.replies) {
      this.logger.debug("slack thread context skipped", { reason: "missing_conversations_replies" });
      return "";
    }

    try {
      const response = await this.fetchRepliesWithRetry(client, input);
      const messages = normalizeMessages(response);
      const contextParts: string[] = [];

      for (const message of messages) {
        const messageTs = message.ts ?? "";
        if (messageTs === input.currentTs) continue;

        const isParent = messageTs === input.threadTs;
        const isBot = Boolean(message.bot_id) || message.subtype === "bot_message";
        const messageUser = message.user ?? "";

        if (isBot && !isParent && input.botUserId && messageUser === input.botUserId) {
          continue;
        }

        const messageText = stripBotMention(message.text?.trim() ?? "", input.botUserId);
        if (!messageText) continue;

        const displayUser = messageUser || (isBot ? message.username : undefined) || "unknown";
        const name = await this.resolveUserName(client, displayUser);
        const prefix = isParent ? "[thread parent] " : "";
        contextParts.push(`${prefix}${name}: ${messageText}`);
      }

      const content = contextParts.length > 0
        ? [
          "[Thread context - prior messages in this thread (not yet in conversation history):]",
          ...contextParts,
          "[End of thread context]",
          "",
          "",
        ].join("\n")
        : "";
      this.cache.set(cacheKey, { content, fetchedAt: now });
      return content;
    } catch (error) {
      this.logger.warn("slack thread context fetch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  private async fetchRepliesWithRetry(
    client: SlackWebClientPort,
    input: SlackThreadContextInput,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.conversations?.replies({
          channel: input.channelId,
          ts: input.threadTs,
          limit: THREAD_CONTEXT_LIMIT + 1,
          inclusive: true,
        });
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt >= 2) break;
        await sleep(1_000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async resolveUserName(client: SlackWebClientPort, userIdOrName: string): Promise<string> {
    if (!looksLikeSlackUserId(userIdOrName) || !client.users?.info) return userIdOrName;

    const cached = this.userNameCache.get(userIdOrName);
    if (cached) return cached;

    try {
      const response = await client.users.info({ user: userIdOrName });
      const user = normalizeUserInfo(response);
      const name = user?.profile?.display_name?.trim() ||
        user?.profile?.real_name?.trim() ||
        user?.real_name?.trim() ||
        user?.name?.trim() ||
        userIdOrName;
      this.userNameCache.set(userIdOrName, name);
      return name;
    } catch (error) {
      this.logger.debug("slack user name lookup skipped", {
        userId: userIdOrName,
        error: error instanceof Error ? error.message : String(error),
      });
      return userIdOrName;
    }
  }
}

function normalizeMessages(response: unknown): SlackConversationMessage[] {
  if (!response || typeof response !== "object" || !("messages" in response)) return [];
  const messages = (response as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((message): message is SlackConversationMessage => {
    return message != null && typeof message === "object";
  });
}

function normalizeUserInfo(response: unknown): SlackUserInfo | null {
  if (!response || typeof response !== "object" || !("user" in response)) return null;
  const user = (response as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  return user as SlackUserInfo;
}

function stripBotMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, "g"), "").trim();
}

function looksLikeSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function isRateLimitError(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error);
  return /ratelimit|rate_limited|429/i.test(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
