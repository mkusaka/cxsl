import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_threads (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      root_message_ts TEXT,
      user_id TEXT,
      context_channel_id TEXT,
      context_team_id TEXT,
      context_enterprise_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, channel_id, thread_ts)
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      slack_thread_id TEXT NOT NULL REFERENCES slack_threads(id),
      codex_thread_id TEXT,
      repo_id TEXT,
      workspace_id TEXT,
      state TEXT NOT NULL,
      active_turn_id TEXT,
      active_generation INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      approval_policy TEXT,
      sandbox_policy TEXT,
      created_by_slack_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_slack_thread_id
      ON agent_sessions(slack_thread_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_codex_thread_id
      ON agent_sessions(codex_thread_id);

    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      codex_turn_id TEXT,
      generation INTEGER NOT NULL,
      user_message_ts TEXT,
      input_preview TEXT,
      input_hash TEXT NOT NULL,
      classified_intent TEXT,
      state TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_turns_session_id
      ON agent_turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_codex_turn_id
      ON agent_turns(codex_turn_id);

    CREATE TABLE IF NOT EXISTS codex_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      turn_id TEXT REFERENCES agent_turns(id),
      codex_thread_id TEXT,
      codex_turn_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_events_session_turn
      ON codex_events(session_id, turn_id);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      turn_id TEXT REFERENCES agent_turns(id),
      codex_request_id TEXT NOT NULL,
      request_method TEXT NOT NULL,
      codex_item_id TEXT,
      codex_approval_id TEXT,
      slack_message_ts TEXT,
      action_type TEXT NOT NULL,
      command TEXT,
      diff_summary TEXT,
      cwd TEXT,
      risk_level TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_slack_user_id TEXT,
      resolution TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_session_turn
      ON approval_requests(session_id, turn_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_slack_user_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      payload TEXT,
      created_at TEXT NOT NULL
    );
  `);
}
