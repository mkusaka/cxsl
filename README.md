# cxsl

Slack gateway for Codex app-server.

## Phase 1 scope

Phase 1 keeps the Slack surface intentionally small:

- Direct messages: handle `message.im`.
- Channel threads: handle `app_mention`; public channel thread replies from allowed users can continue without mentioning the app.
- Slack assistant surface: handle `assistant_thread_started` and continue the assistant thread through the Codex app-server.
- Codex runtime: call a shared `codex app-server` stdio process from the worker.
- State: persist Slack thread/session/turn/approval audit data in SQLite.
- Approvals: natural-language approvals are not accepted. Phase 1 records app-server approval requests and declines them; Slack button approval is the next implementation phase.

In public channel threads, unmentioned replies that start with `!aside` are ignored. Mentioning the app still sends the message to Codex.

Out of scope for v0.1:

- Reading root channel messages without an app mention.
- Slash commands, shortcuts, file ingestion, multi-workspace OAuth install flow, or approval button handling.
- Per-thread Codex app-server processes.

## Slack app setup

Create or update a Slack app from `manifest.yml`. For the full click-by-click setup, see [docs/slack-setup.md](docs/slack-setup.md).

The manifest enables Socket Mode and Events API subscriptions. Interactivity is also enabled so approval buttons can be added in the next phase. After installing the app, create an app-level token with `connections:write` for Socket Mode and store it as `SLACK_APP_TOKEN`.

Bot scopes:

- `app_mentions:read` for channel mentions.
- `channels:history` for public channel thread replies without an app mention.
- `im:history` for direct messages to the app.
- `chat:write` for thread replies and approval messages.
- `assistant:write` for the Slack assistant surface.

Subscribed bot events:

- `app_mention`
- `message.channels`
- `message.im`
- `assistant_thread_started`
- `assistant_thread_context_changed`

## Configuration

Copy `.env.example` to `.env` and fill in local values.

Required:

- `SLACK_BOT_TOKEN`: bot token from OAuth & Permissions.
- `SLACK_APP_TOKEN`: app-level token for Socket Mode.

Common local settings:

- `DATABASE_PATH`: SQLite database path. Defaults to `.data/cxsl.sqlite`.
- `CODEX_COMMAND`: Codex executable. Defaults to `codex`.
- `CODEX_ARGS`: JSON array or whitespace-separated args. Defaults to `app-server`.
- `CODEX_DEFAULT_CWD`: default workspace for Codex turns. Defaults to this repo.
- `CODEX_DEFAULT_MODEL`: optional Codex model override.
- `CODEX_APPROVAL_POLICY`: one of `untrusted`, `on-failure`, `on-request`, `never`.
- `CODEX_SANDBOX`: one of `read-only`, `workspace-write`, `danger-full-access`.
- `SLACK_ALLOWED_USER_IDS`: optional comma-separated allowlist.
- `SLACK_ALLOWED_CHANNEL_IDS`: optional comma-separated allowlist.
- `SLACK_STREAMING_ENABLED`: reserved for Phase 2 streaming; Phase 1 posts final responses with Slack `markdown_text`.
- `LOG_LEVEL`: one of `debug`, `info`, `warn`, `error`.

## Development

```sh
pnpm install
cp .env.example .env
pnpm dev
```

For a production build:

```sh
pnpm build
pnpm start
```

## Data retention

Phase 1 stores operational state in SQLite: Slack thread identity, Codex session/turn IDs, minimized Codex event metadata, approval request records, and audit logs. Slack message text is stored as a redacted preview plus a hash, not as the full message. The database is local to the worker by default under `.data/` and is ignored by git.

Do not commit `.env`, `.data/`, Slack tokens, Codex auth material, or database snapshots. If retention limits are required, implement them as an explicit cleanup policy before broad deployment.

## Slack response formatting

Final Codex responses are sent with Slack's `markdown_text` field so standard Markdown from Codex can be rendered by Slack directly. Each Slack message is split below the `markdown_text` 12,000 character limit before posting to avoid Slack-side truncation.
