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
import { SlackRenderer } from "./renderer.ts";
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
      await orchestrator.handleSlackInput(input, new SlackRenderer(client, logger));
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
    await orchestrator.handleSlackInput(input, new SlackRenderer(client, logger));
  });

  app.message(async ({ message, client, context }) => {
    logger.debug("message event received", summarizeSlackEvent(message, context));
    const input = dmMessageToInput(message, context);
    if (!input) {
      logger.debug("message event ignored", {
        reason: inputDropReason(message),
        ...summarizeSlackEvent(message, context),
      });
      return;
    }
    await orchestrator.handleSlackInput(input, new SlackRenderer(client, logger));
  });

  return app;
}

type SlackContext = Pick<Context, "teamId">;

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

function appMentionToInput(
  event: SlackEventMiddlewareArgs<"app_mention">["event"],
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
