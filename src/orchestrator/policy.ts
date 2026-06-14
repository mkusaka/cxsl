import type { AppConfig } from "../config.ts";
import type { SlackInput } from "../slack/input.ts";

export function assertAllowed(config: AppConfig, input: SlackInput): void {
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(input.userId)) {
    throw new Error("This Slack user is not allowed to use cxsl.");
  }
  if (
    config.allowedChannelIds.size > 0 &&
    !config.allowedChannelIds.has(input.channelId)
  ) {
    throw new Error("This Slack channel is not allowed to use cxsl.");
  }
}
