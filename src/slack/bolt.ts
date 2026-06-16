import {
  App,
  Assistant,
  LogLevel,
  type AnyMiddlewareArgs,
  type Context,
  type SlackEventMiddlewareArgs,
} from "@slack/bolt";
import * as v from "valibot";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { SlackPolicyError } from "../orchestrator/policy.ts";
import { SlackRenderer, type SlackWebClientPort } from "./renderer.ts";
import { SlackThreadContextFetcher } from "./thread-context.ts";
import { shouldIgnoreMessage, stripBotMentions, type SlackInput } from "./input.ts";

export function createSlackApp(
  config: AppConfig,
  orchestrator: Orchestrator,
  logger: Logger,
): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: slackLogLevel(config.logLevel),
  });

  app.use(async (args) => {
    logger.debug("slack payload received", summarizeSlackArgs(args));
    await args.next();
  });

  app.error(async (error) => {
    logger.error("slack listener error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const threadContextFetcher = new SlackThreadContextFetcher(logger);

  const assistant = new Assistant({
    threadStarted: async ({ event, context, say, setSuggestedPrompts, saveThreadContext }) => {
      logger.debug("assistant thread started", summarizeAssistantThreadEvent(event, context));
      await say("How can I help?");
      await saveThreadContext();
      await setSuggestedPrompts({
        title: "Ask Codex",
        prompts: [
          {
            title: "Inspect this repo",
            message: "Inspect this repo structure and suggest what to look at next.",
          },
          {
            title: "Plan a change",
            message: "Plan how to implement this change.",
          },
        ],
      });
    },
    threadContextChanged: async ({ event, context, saveThreadContext }) => {
      logger.debug("assistant thread context changed", summarizeAssistantThreadEvent(event, context));
      await saveThreadContext();
    },
    userMessage: async ({ message, client, context }) => {
      logger.debug("assistant user message received", summarizeSlackEvent(message, context));
      const input = assistantMessageToInput(message, context);
      if (!input) {
        logger.debug("assistant user message ignored", {
          reason: inputDropReason(message),
          ...summarizeSlackEvent(message, context),
        });
        return;
      }
      await handleSlackInputWithPolicyFeedback(
        orchestrator,
        input,
        new SlackRenderer(client, logger),
        logger,
        true,
        {
          threadContextProvider: threadContextFetcher.providerFor(
            client as SlackWebClientPort,
            context.botUserId,
          ),
        },
      );
    },
  });

  app.assistant(assistant);

  app.event("app_mention", async ({ event, client, context }) => {
    logger.debug("app mention received", summarizeSlackEvent(event, context));
    const input = appMentionToInput(event, context);
    if (!input) {
      logger.debug("app mention ignored", {
        reason: inputDropReason(event),
        ...summarizeSlackEvent(event, context),
      });
      return;
    }
    await handleSlackInputWithPolicyFeedback(
      orchestrator,
      input,
      new SlackRenderer(client, logger),
      logger,
      true,
      {
        threadContextProvider: threadContextFetcher.providerFor(
          client as SlackWebClientPort,
          context.botUserId,
        ),
      },
    );
  });

  app.event("message", async ({ event, client, context }) => {
    logger.debug("message event received", summarizeSlackEvent(event, context));
    const input = messageEventToInput(event, context, config);
    if (!input) {
      logger.debug("message event ignored", {
        reason: messageEventDropReason(event, context, config),
        ...summarizeSlackEvent(event, context),
      });
      return;
    }
    await handleSlackInputWithPolicyFeedback(
      orchestrator,
      input,
      new SlackRenderer(client, logger),
      logger,
      input.source !== "channel_thread",
      {
        threadContextProvider: threadContextFetcher.providerFor(
          client as SlackWebClientPort,
          context.botUserId,
        ),
      },
    );
  });

  app.action("cxsl_approval_approve", async (args) => {
    await args.ack();
    await handleApprovalActionFromSlack(orchestrator, "approve", args, logger);
  });

  app.action("cxsl_approval_decline", async (args) => {
    await args.ack();
    await handleApprovalActionFromSlack(orchestrator, "decline", args, logger);
  });

  return app;
}

type SlackContext = Pick<Context, "botUserId" | "teamId">;

type SlackMessageForInput = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  team?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
};

function assistantMessageToInput(
  message: SlackMessageForInput,
  context: SlackContext,
): SlackInput | null {
  if (shouldIgnoreMessage(message)) return null;
  const text = message.text?.trim() ?? "";
  if (!text) return null;
  return commonInput("assistant", message, context, text);
}

function dmMessageToInput(
  message: SlackMessageForInput,
  context: SlackContext,
): SlackInput | null {
  if (shouldIgnoreMessage(message)) return null;
  if (message.channel_type !== "im") return null;
  const text = message.text?.trim() ?? "";
  if (!text) return null;
  return commonInput("dm", message, context, text);
}

export function messageEventToInput(
  message: SlackMessageForInput,
  context: SlackContext,
  config: Pick<AppConfig, "allowedChannelIds" | "allowedUserIds">,
): SlackInput | null {
  return dmMessageToInput(message, context) ??
    channelThreadMessageToInput(message, context, config);
}

export function channelThreadMessageToInput(
  message: SlackMessageForInput,
  context: SlackContext,
  config: Pick<AppConfig, "allowedChannelIds" | "allowedUserIds">,
): SlackInput | null {
  if (shouldIgnoreMessage(message)) return null;
  if (!isThreadChannelType(message.channel_type)) return null;
  if (!message.thread_ts || message.thread_ts === message.ts) return null;

  const text = message.text?.trim() ?? "";
  if (!text) return null;
  if (mentionsBot(text, context.botUserId)) return null;
  if (isAsideMessage(text)) return null;
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(message.user ?? "")) return null;
  if (config.allowedChannelIds.size > 0 && !config.allowedChannelIds.has(message.channel ?? "")) {
    return null;
  }

  return commonInput("channel_thread", message, context, text);
}

export function appMentionToInput(
  event: SlackMessageForInput & { text: string },
  context: SlackContext,
): SlackInput | null {
  if (shouldIgnoreMessage(event)) return null;
  const text = stripBotMentions(event.text);
  if (!text) return null;
  return commonInput("app_mention", event, context, text);
}

function commonInput(
  source: SlackInput["source"],
  event: SlackMessageForInput,
  context: SlackContext,
  text: string,
): SlackInput | null {
  const teamId = event.team ?? context.teamId;
  const channelId = event.channel;
  const messageTs = event.ts;
  const userId = event.user;
  if (!teamId || !channelId || !messageTs || !userId) return null;

  return {
    source,
    teamId,
    channelId,
    threadTs: event.thread_ts ?? messageTs,
    messageTs,
    userId,
    text,
  };
}

function summarizeSlackArgs(args: {
  body?: AnyMiddlewareArgs["body"];
  payload?: AnyMiddlewareArgs["payload"];
  context?: SlackContext;
}): Record<string, unknown> {
  const result = v.safeParse(SlackArgsSummarySchema, args);
  if (!result.success) return {};

  const { body, payload, context } = result.output;
  const event = body?.event ?? payload;
  return {
    bodyType: body?.type,
    eventType: event?.type,
    eventSubtype: event?.subtype,
    channelType: event?.channel_type,
    teamId: event?.team ?? context?.teamId,
    channelId: event?.channel,
    userId: event?.user,
    threadTs: event?.thread_ts,
    messageTs: event?.ts,
    hasText: event?.text != null && event.text.length > 0,
  };
}

export async function handleSlackInputWithPolicyFeedback(
  orchestrator: Pick<Orchestrator, "handleSlackInput">,
  input: SlackInput,
  renderer: SlackRenderer,
  logger: Pick<Logger, "debug">,
  notifyPolicyErrors: boolean,
  options?: Parameters<Orchestrator["handleSlackInput"]>[2],
): Promise<void> {
  try {
    await orchestrator.handleSlackInput(input, renderer, options);
  } catch (error) {
    if (!(error instanceof SlackPolicyError)) throw error;

    logger.debug("slack input rejected by policy", {
      reason: error.reason,
      source: input.source,
      channelId: input.channelId,
      userId: input.userId,
      threadTs: input.threadTs,
      messageTs: input.messageTs,
    });
    if (!notifyPolicyErrors) return;

    try {
      await renderer.postEphemeralMessage({
        channelId: input.channelId,
        userId: input.userId,
        threadTs: input.threadTs,
        text: error.message,
      });
    } catch (postError) {
      logger.debug("policy error ephemeral message skipped", {
        error: postError instanceof Error ? postError.message : String(postError),
      });
    }
  }
}

function mentionsBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return false;
  return new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`).test(text);
}

function isAsideMessage(text: string): boolean {
  return text.trimStart().startsWith("!aside");
}

function isThreadChannelType(channelType: string | undefined): boolean {
  return channelType == null || channelType === "channel" || channelType === "group";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SlackEventSummarySchema = v.looseObject({
  type: v.optional(v.string()),
  subtype: v.optional(v.string()),
  channel_type: v.optional(v.string()),
  team: v.optional(v.string()),
  channel: v.optional(v.string()),
  user: v.optional(v.string()),
  thread_ts: v.optional(v.string()),
  ts: v.optional(v.string()),
  text: v.optional(v.string()),
});
type SlackEventSummaryFields = SlackMessageForInput;

const SlackArgsSummarySchema = v.looseObject({
  body: v.optional(v.looseObject({
    type: v.optional(v.string()),
    event: v.optional(SlackEventSummarySchema),
  })),
  payload: v.optional(SlackEventSummarySchema),
  context: v.optional(v.looseObject({
    teamId: v.optional(v.string()),
  })),
});

function summarizeSlackEvent(
  event: SlackEventSummaryFields,
  context: SlackContext,
): Record<string, unknown> {
  return {
    eventType: event.type,
    eventSubtype: event.subtype,
    channelType: event.channel_type,
    teamId: event.team ?? context.teamId,
    channelId: event.channel,
    userId: event.user,
    threadTs: event.thread_ts,
    messageTs: event.ts,
    hasText: event.text != null && event.text.length > 0,
  };
}

function summarizeAssistantThreadEvent(
  event:
    | SlackEventMiddlewareArgs<"assistant_thread_started">["event"]
    | SlackEventMiddlewareArgs<"assistant_thread_context_changed">["event"],
  context: SlackContext,
): Record<string, unknown> {
  return {
    eventType: event.type,
    teamId: event.assistant_thread.context.team_id ?? context.teamId,
    channelId: event.assistant_thread.channel_id,
    userId: event.assistant_thread.user_id,
    threadTs: event.assistant_thread.thread_ts,
  };
}

function inputDropReason(event: SlackEventSummaryFields & { bot_id?: string }): string {
  if (event.subtype) return "subtype";
  if (event.bot_id) return "bot_message";
  if (event.user == null) return "missing_user";
  if (event.channel_type != null && event.channel_type !== "im") return "non_im_message";
  if (typeof event.text !== "string" || event.text.trim() === "") return "empty_text";
  return "missing_required_fields";
}

function messageEventDropReason(
  event: SlackEventSummaryFields & { bot_id?: string },
  context: SlackContext,
  config: Pick<AppConfig, "allowedChannelIds" | "allowedUserIds">,
): string {
  if (event.subtype) return "subtype";
  if (event.bot_id) return "bot_message";
  if (event.user == null) return "missing_user";
  if (event.channel_type === "im") return inputDropReason(event);
  if (!isThreadChannelType(event.channel_type)) return "non_channel_thread_message";
  if (!event.thread_ts || event.thread_ts === event.ts) return "root_message";

  const text = event.text?.trim() ?? "";
  if (!text) return "empty_text";
  if (mentionsBot(text, context.botUserId)) return "mentioned_bot";
  if (isAsideMessage(text)) return "aside";
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(event.user ?? "")) return "disallowed_user";
  if (config.allowedChannelIds.size > 0 && !config.allowedChannelIds.has(event.channel ?? "")) {
    return "disallowed_channel";
  }
  return "missing_required_fields";
}

async function handleApprovalActionFromSlack(
  orchestrator: Pick<Orchestrator, "handleApprovalAction">,
  decision: "approve" | "decline",
  args: {
    body: unknown;
    action: unknown;
    client: unknown;
  },
  logger: Pick<Logger, "debug" | "error">,
): Promise<void> {
  const approvalRequestId = extractActionValue(args.action);
  const actorSlackUserId = extractNestedString(args.body, ["user", "id"]);
  const channelId = extractNestedString(args.body, ["channel", "id"]);
  const messageTs = extractNestedString(args.body, ["message", "ts"]);

  if (!approvalRequestId || !actorSlackUserId || !channelId || !messageTs) {
    logger.debug("approval action ignored", {
      hasApprovalRequestId: Boolean(approvalRequestId),
      hasActorSlackUserId: Boolean(actorSlackUserId),
      hasChannelId: Boolean(channelId),
      hasMessageTs: Boolean(messageTs),
    });
    return;
  }

  try {
    await orchestrator.handleApprovalAction({
      approvalRequestId,
      actorSlackUserId,
      decision,
      channelId,
      messageTs,
      renderer: new SlackRenderer(args.client as SlackWebClientPort, logger),
    });
  } catch (error) {
    logger.error("approval action failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractActionValue(action: unknown): string | null {
  if (!action || typeof action !== "object" || !("value" in action)) return null;
  const value = action.value;
  return typeof value === "string" ? value : null;
}

function extractNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

function slackLogLevel(level: AppConfig["logLevel"]): LogLevel {
  switch (level) {
    case "debug":
      return LogLevel.DEBUG;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}
