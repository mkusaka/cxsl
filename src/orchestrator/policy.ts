import type { AppConfig } from "../config.ts";
import type { SlackInput } from "../slack/input.ts";

export type SlackPolicyErrorReason = "user" | "channel";

export class SlackPolicyError extends Error {
  readonly reason: SlackPolicyErrorReason;

  constructor(reason: SlackPolicyErrorReason, message: string) {
    super(message);
    this.name = "SlackPolicyError";
    this.reason = reason;
  }
}

export function assertAllowed(config: AppConfig, input: SlackInput): void {
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(input.userId)) {
    throw new SlackPolicyError("user", "This Slack user is not allowed to use cxsl.");
  }
  if (
    config.allowedChannelIds.size > 0 &&
    !config.allowedChannelIds.has(input.channelId)
  ) {
    throw new SlackPolicyError("channel", "This Slack channel is not allowed to use cxsl.");
  }
}
