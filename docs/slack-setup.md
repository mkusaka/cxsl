# Slack app setup

This document sets up one local development Slack app for `cxsl`. It assumes a single workspace, Socket Mode, and Phase 1 behavior: direct messages, assistant threads, and channel app mentions.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps>.
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Select the development workspace.
5. Paste the contents of [`../manifest.yml`](../manifest.yml).
6. Review the app summary and create the app.

The manifest enables:

- Socket Mode.
- Bot user.
- Bot user presence set to always online.
- App Home Messages tab with user messages enabled.
- Agents & AI Apps assistant view.
- Interactivity for later approval buttons.
- Events for `app_mention`, `message.im`, `assistant_thread_started`, and `assistant_thread_context_changed`.

## 2. Install and collect tokens

Install or reinstall the app after creating it from the manifest:

1. Go to **OAuth & Permissions**.
2. Click **Install to Workspace** or **Reinstall to Workspace**.
3. Copy the bot token into `.env` as `SLACK_BOT_TOKEN`.

The bot token starts with `xoxb-`. Treat it as a secret.

Create the Socket Mode app-level token:

1. Go to **Basic Information**.
2. Find **App-Level Tokens**.
3. Generate a token with the `connections:write` scope.
4. Copy it into `.env` as `SLACK_APP_TOKEN`.

The app-level token starts with `xapp-`. Treat it as a secret.

## 3. Configure local environment

```sh
pnpm install
cp .env.example .env
```

Fill in:

```sh
SLACK_BOT_TOKEN=xoxb-<redacted>
SLACK_APP_TOKEN=xapp-<redacted>
```

Optional local settings:

```sh
SLACK_ALLOWED_USER_IDS=U...
SLACK_ALLOWED_CHANNEL_IDS=C...
CODEX_DEFAULT_CWD=/path/to/repo
LOG_LEVEL=debug
```

Do not commit `.env`, `.data/`, Slack tokens, Codex auth material, or SQLite database snapshots.

## 4. Start the local worker

```sh
pnpm dev
```

Expected startup behavior:

- Bolt connects to Slack over Socket Mode.
- The worker spawns one shared `codex app-server` process.
- SQLite state is created at `.data/cxsl.sqlite` unless `DATABASE_PATH` overrides it.

Socket Mode does not require a public Request URL or ngrok for this Phase 1 setup.

## 5. Try it in Slack

Direct message:

1. Open a DM with the app.
2. Send a question.
3. The app should reply in the same DM thread after Codex completes.

Channel mention:

1. Invite the app to a test channel.
2. Send `@cxsl Inspect this repo`.
3. Continue the same thread by mentioning the app again.

Channel thread replies must mention the app in Phase 1. Plain thread replies in channels are intentionally ignored because `message.channels` and `message.groups` are not subscribed.

Assistant thread:

1. Open the app's assistant surface in Slack.
2. Start an assistant thread.
3. Confirm the app posts `How can I help?`.
4. Use one of the suggested prompts or type a new request.

The assistant side panel is backed by Slack's `assistant_thread_started`, `assistant_thread_context_changed`, and `message.im` events. Reinstall the app after applying the manifest so Slack sends all three events.

Phase 1 sets a Slack thread status while Codex is generating and then posts the final response with Slack `markdown_text`. Long responses are split before Slack's `markdown_text` character limit. Token streaming and approval buttons are the next phases.

## 6. Response-time feedback

Slack has two relevant APIs for response-time feedback:

- `assistant.threads.setStatus` shows a thread-level loading state while the app is working. `cxsl` calls this immediately with `Thinking...` and clears it after posting a response.
- `chat.startStream`, `chat.appendStream`, and `chat.stopStream` provide token-by-token streaming. `cxsl` keeps this for Phase 2.

## 7. Troubleshooting

If no events arrive:

- Confirm Socket Mode is enabled.
- Confirm `SLACK_APP_TOKEN` is an app-level token with `connections:write`.
- Confirm the process is running with `pnpm dev`.
- Reinstall the app after changing scopes or events in the manifest.
- Confirm App Home's Messages tab is enabled and not read-only. In the manifest this is `features.app_home.messages_tab_enabled: true` and `features.app_home.messages_tab_read_only_enabled: false`.
- Run with `LOG_LEVEL=debug` and look for `slack payload received`.
- If Slack's Socket Mode `hello` message reports `num_connections` greater than `1`, stop duplicate local workers. Socket Mode may deliver payloads to any active connection.
- A short ping/pong timeout followed by reconnect is expected Socket Mode behavior during network hiccups or connection refreshes. It is only actionable if reconnects loop continuously or no payload logs appear after reconnect.

If app mentions do not work:

- Confirm the app is invited to the channel.
- Confirm `app_mentions:read` and `chat:write` are present under bot scopes.
- Confirm the channel is allowed by `SLACK_ALLOWED_CHANNEL_IDS`, if set.

If assistant threads do not work:

- Confirm Agents & AI Apps is enabled for the Slack app.
- Confirm `assistant:write`, `chat:write`, and `im:history` are present.
- Confirm `assistant_thread_started`, `assistant_thread_context_changed`, and `message.im` are subscribed.
- With `LOG_LEVEL=debug`, confirm `assistant thread started`, `chat.postMessage`, and then `assistant user message received` appear in that order.

If Codex fails to start:

- Run `codex app-server generate-ts --out .codex-schema/app-server` to confirm the Codex CLI is visible.
- Check `CODEX_COMMAND` and `CODEX_ARGS`.
- Check the worker logs for app-server initialization errors.

## 8. Current manifest scope

Required bot scopes in [`../manifest.yml`](../manifest.yml):

- `app_mentions:read`
- `assistant:write`
- `chat:write`
- `im:history`

Required app-level token scope:

- `connections:write`

Optional future additions:

- `commands` scope and slash command definitions, once `/codex status` and related control-plane commands are implemented.
- `channels:history` / `groups:history`, only if channel context retrieval is explicitly added.

## 9. References

- Slack app manifests: <https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests>
- Socket Mode and app-level tokens: <https://docs.slack.dev/apis/events-api/using-socket-mode>
- Agents and AI Apps setup: <https://docs.slack.dev/tools/java-slack-sdk/guides/ai-apps>
- `assistant_thread_started`: <https://docs.slack.dev/reference/events/assistant_thread_started>
- `assistant.threads.setStatus`: <https://docs.slack.dev/reference/methods/assistant.threads.setStatus>
- Streaming messages: <https://docs.slack.dev/reference/methods/chat.startStream>
