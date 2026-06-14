import type { Logger } from "../logger.ts";

export const SLACK_MARKDOWN_TEXT_CHAR_LIMIT = 12_000;
export const SLACK_MARKDOWN_TEXT_CHUNK_LIMIT = 11_000;

export type SlackWebClientPort = {
  assistant: {
    threads: {
      setStatus(input: {
        channel_id: string;
        thread_ts: string;
        status: string;
        loading_messages?: string[];
      }): Promise<unknown>;
    };
  };
  chat: {
    postMessage(input: {
      channel: string;
      thread_ts: string;
      markdown_text: string;
      unfurl_links: false;
      unfurl_media: false;
    }): Promise<unknown>;
    postEphemeral(input: {
      channel: string;
      user: string;
      thread_ts?: string;
      markdown_text: string;
    }): Promise<unknown>;
  };
};

export class SlackRenderer {
  private readonly client: SlackWebClientPort;
  private readonly logger: Pick<Logger, "debug">;

  constructor(client: SlackWebClientPort, logger: Pick<Logger, "debug">) {
    this.client = client;
    this.logger = logger;
  }

  async setAssistantStatus(input: {
    channelId: string;
    threadTs: string;
    status: string;
    loadingMessages?: string[];
  }): Promise<void> {
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
        loading_messages: input.loadingMessages,
      });
    } catch (error) {
      this.logger.debug("assistant status update skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async postThreadMessage(input: {
    channelId: string;
    threadTs: string;
    text: string;
  }): Promise<void> {
    for (const chunk of splitSlackMarkdown(input.text)) {
      await this.client.chat.postMessage({
        channel: input.channelId,
        thread_ts: input.threadTs,
        markdown_text: chunk,
        unfurl_links: false,
        unfurl_media: false,
      });
    }
  }

  async postEphemeralMessage(input: {
    channelId: string;
    userId: string;
    threadTs?: string;
    text: string;
  }): Promise<void> {
    for (const chunk of splitSlackMarkdown(input.text)) {
      await this.client.chat.postEphemeral({
        channel: input.channelId,
        user: input.userId,
        thread_ts: input.threadTs,
        markdown_text: chunk,
      });
    }
  }
}

export function splitSlackMarkdown(
  markdown: string,
  maxChars = SLACK_MARKDOWN_TEXT_CHUNK_LIMIT,
): string[] {
  if (maxChars <= 0 || maxChars > SLACK_MARKDOWN_TEXT_CHAR_LIMIT) {
    throw new Error(`maxChars must be between 1 and ${SLACK_MARKDOWN_TEXT_CHAR_LIMIT}`);
  }

  if (markdown.length === 0) return [""];
  if (markdown.length <= maxChars) return [markdown];

  const chunks: string[] = [];
  const lines = markdown.match(/[^\n]*\n|[^\n]+/g) ?? [markdown];
  let current = "";
  let openFence = false;
  let fenceHeader = "";

  for (const line of lines) {
    if (line.length > maxChars) {
      current = flushCurrent(chunks, current, openFence, maxChars);
      current = appendLongLine(chunks, current, line, openFence, fenceHeader, maxChars);
      continue;
    }

    if (current.length > 0 && current.length + line.length > maxChars) {
      current = flushCurrent(chunks, current, openFence, maxChars);
      if (openFence) current = reopenFence(fenceHeader);
    }

    current += line;
    const fence = parseFence(line);
    if (fence != null) {
      if (openFence) {
        openFence = false;
        fenceHeader = "";
      } else {
        openFence = true;
        fenceHeader = fence;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function flushCurrent(
  chunks: string[],
  current: string,
  openFence: boolean,
  maxChars: number,
): string {
  if (current.length === 0) return "";
  const suffix = openFence ? "\n```" : "";
  chunks.push(
    current.length + suffix.length <= maxChars
      ? current + suffix
      : current,
  );
  return "";
}

function appendLongLine(
  chunks: string[],
  current: string,
  line: string,
  openFence: boolean,
  fenceHeader: string,
  maxChars: number,
): string {
  let rest = line;
  let next = current;
  while (rest.length > 0) {
    const prefix = next.length === 0 && openFence ? reopenFence(fenceHeader) : "";
    if (prefix && prefix.length >= maxChars) {
      throw new Error("Fence header is too long for Slack markdown chunking");
    }
    if (next.length === 0) next = prefix;
    const available = maxChars - next.length - (openFence ? 4 : 0);
    const take = Math.max(1, Math.min(available, rest.length));
    next += rest.slice(0, take);
    rest = rest.slice(take);
    if (rest.length > 0) {
      next = flushCurrent(chunks, next, openFence, maxChars);
    }
  }
  return next;
}

function reopenFence(fenceHeader: string): string {
  return `\`\`\`${fenceHeader}\n`;
}

function parseFence(line: string): string | null {
  const match = line.match(/^\s*```([^\n`]*)\s*$/);
  return match ? match[1] ?? "" : null;
}
