export type SlackInputSource = "assistant" | "dm" | "app_mention";

export type SlackInput = {
  source: SlackInputSource;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
};

type SlackMessageForFiltering = {
  subtype?: string;
  bot_id?: string;
  user?: string;
};

export function stripBotMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

export function shouldIgnoreMessage(message: SlackMessageForFiltering): boolean {
  if (message.subtype) return true;
  if (message.bot_id) return true;
  if (message.user == null) return true;
  return false;
}
