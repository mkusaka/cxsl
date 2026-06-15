import type { Logger } from "../logger.ts";
import type { Block, KnownBlock } from "@slack/types";

export const SLACK_MARKDOWN_TEXT_CHAR_LIMIT = 12_000;
export const SLACK_MARKDOWN_TEXT_CHUNK_LIMIT = 11_000;

type SlackBlock = Block | KnownBlock;
type SlackPostMessageInput =
  | {
    channel: string;
    thread_ts: string;
    markdown_text: string;
    unfurl_links: false;
    unfurl_media: false;
  }
  | {
    channel: string;
    thread_ts: string;
    text: string;
    blocks: SlackBlock[];
    unfurl_links: false;
    unfurl_media: false;
  };

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
    postMessage(input: SlackPostMessageInput): Promise<{ ts?: string } | unknown>;
    update?(input: {
      channel: string;
      ts: string;
      text?: string;
      blocks?: SlackBlock[];
    }): Promise<unknown>;
    postEphemeral(input: {
      channel: string;
      user: string;
      thread_ts?: string;
      markdown_text: string;
    }): Promise<unknown>;
    startStream?(input: {
      channel: string;
      thread_ts: string;
      markdown_text?: string;
    }): Promise<{ ts?: string } | unknown>;
    appendStream?(input: {
      channel: string;
      ts: string;
      markdown_text: string;
    }): Promise<unknown>;
    stopStream?(input: {
      channel: string;
      ts: string;
      markdown_text?: string;
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

  async startThreadStream(input: {
    channelId: string;
    threadTs: string;
  }): Promise<{ streamTs: string } | null> {
    if (!this.client.chat.startStream) return null;

    try {
      const response = await this.client.chat.startStream({
        channel: input.channelId,
        thread_ts: input.threadTs,
        markdown_text: "",
      });
      const streamTs = extractSlackTs(response);
      return streamTs ? { streamTs } : null;
    } catch (error) {
      this.logger.debug("slack stream start skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async appendThreadStream(input: {
    channelId: string;
    streamTs: string;
    text: string;
  }): Promise<void> {
    if (!this.client.chat.appendStream) return;
    await this.client.chat.appendStream({
      channel: input.channelId,
      ts: input.streamTs,
      markdown_text: input.text,
    });
  }

  async stopThreadStream(input: {
    channelId: string;
    streamTs: string;
    text?: string;
  }): Promise<void> {
    if (!this.client.chat.stopStream) return;
    await this.client.chat.stopStream({
      channel: input.channelId,
      ts: input.streamTs,
      markdown_text: input.text,
    });
  }

  async postApprovalRequest(input: {
    channelId: string;
    threadTs: string;
    approvalRequestId: string;
    title: string;
    text: string;
  }): Promise<{ messageTs: string | null }> {
    const response = await this.client.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: input.title,
      blocks: approvalBlocks(input),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { messageTs: extractSlackTs(response) };
  }

  async updateApprovalRequest(input: {
    channelId: string;
    messageTs: string;
    title: string;
    text: string;
  }): Promise<void> {
    if (!this.client.chat.update) return;
    await this.client.chat.update({
      channel: input.channelId,
      ts: input.messageTs,
      text: input.title,
      blocks: resolvedApprovalBlocks(input),
    });
  }
}

function extractSlackTs(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const ts = (response as { ts?: unknown }).ts;
  return typeof ts === "string" ? ts : null;
}

function approvalBlocks(input: {
  approvalRequestId: string;
  title: string;
  text: string;
}): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeMrkdwn(input.title)}*\n${escapeMrkdwn(input.text)}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "cxsl_approval_approve",
          value: input.approvalRequestId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Decline" },
          style: "danger",
          action_id: "cxsl_approval_decline",
          value: input.approvalRequestId,
        },
      ],
    },
  ];
}

function resolvedApprovalBlocks(input: {
  title: string;
  text: string;
}): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeMrkdwn(input.title)}*\n${escapeMrkdwn(input.text)}` },
    },
  ];
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
