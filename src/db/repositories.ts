import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import * as v from "valibot";
import { redactSensitiveText, redactSensitiveValue } from "../security/redaction.ts";
import { newId, nowIso } from "../util/id.ts";

export type SlackThreadInput = {
  teamId: string;
  channelId: string;
  threadTs: string;
  rootMessageTs?: string;
  userId: string;
  contextChannelId?: string;
  contextTeamId?: string;
  contextEnterpriseId?: string;
};

export type SlackThread = {
  id: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string | null;
};

export type AgentSession = {
  id: string;
  slackThreadId: string;
  codexThreadId: string | null;
  state: string;
  activeTurnId: string | null;
  activeGeneration: number;
  model: string | null;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
  createdBySlackUserId: string;
};

export type AgentTurn = {
  id: string;
  sessionId: string;
  codexTurnId: string | null;
  generation: number;
  state: string;
};

const NullableStringSchema = v.nullable(v.string());

const SlackThreadRowSchema = v.object({
  id: v.string(),
  team_id: v.string(),
  channel_id: v.string(),
  thread_ts: v.string(),
  user_id: NullableStringSchema,
});
type SlackThreadRow = v.InferOutput<typeof SlackThreadRowSchema>;

const AgentSessionRowSchema = v.object({
  id: v.string(),
  slack_thread_id: v.string(),
  codex_thread_id: NullableStringSchema,
  state: v.string(),
  active_turn_id: NullableStringSchema,
  active_generation: v.number(),
  model: NullableStringSchema,
  approval_policy: NullableStringSchema,
  sandbox_policy: NullableStringSchema,
  created_by_slack_user_id: v.string(),
});
type AgentSessionRow = v.InferOutput<typeof AgentSessionRowSchema>;

type AgentTurnRow = {
  id: string;
  session_id: string;
  codex_turn_id: string | null;
  generation: number;
  state: string;
};

const LooseRecordSchema = v.looseObject({});
const ItemTypeSchema = v.looseObject({
  type: v.string(),
});
const ErrorMessageSchema = v.looseObject({
  message: v.string(),
});

function readOptionalRow<const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  row: Record<string, SQLOutputValue> | undefined,
  schema: TSchema,
  tableName: string,
): v.InferOutput<TSchema> | undefined {
  if (row === undefined) return undefined;
  try {
    return v.parse(schema, row);
  } catch {
    throw new Error(`Malformed ${tableName} row`);
  }
}

export class Repositories {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  resolveSlackThread(input: SlackThreadInput): SlackThread {
    const now = nowIso();
    const existing = readOptionalRow(
      this.db
      .prepare(
        `SELECT id, team_id, channel_id, thread_ts, user_id
         FROM slack_threads
         WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
      )
        .get(input.teamId, input.channelId, input.threadTs),
      SlackThreadRowSchema,
      "slack_threads",
    );

    if (existing) {
      this.db
        .prepare(
          `UPDATE slack_threads
           SET user_id = COALESCE(?, user_id), updated_at = ?
           WHERE id = ?`,
        )
        .run(input.userId, now, existing.id);
      return mapSlackThread(existing);
    }

    const id = newId();
    this.db
      .prepare(
        `INSERT INTO slack_threads (
          id, team_id, channel_id, thread_ts, root_message_ts, user_id,
          context_channel_id, context_team_id, context_enterprise_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
        input.channelId,
        input.threadTs,
        input.rootMessageTs ?? null,
        input.userId,
        input.contextChannelId ?? null,
        input.contextTeamId ?? null,
        input.contextEnterpriseId ?? null,
        now,
        now,
      );

    return {
      id,
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.userId,
    };
  }

  resolveSession(input: {
    slackThreadId: string;
    userId: string;
    model?: string;
    approvalPolicy: string;
    sandboxPolicy: string;
  }): AgentSession {
    const existing = readOptionalRow(
      this.db
      .prepare(
        `SELECT id, slack_thread_id, codex_thread_id, state, active_turn_id,
                active_generation, model, approval_policy, sandbox_policy,
                created_by_slack_user_id
         FROM agent_sessions
         WHERE slack_thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
        .get(input.slackThreadId),
      AgentSessionRowSchema,
      "agent_sessions",
    );

    if (existing) return mapAgentSession(existing);

    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_sessions (
          id, slack_thread_id, state, active_generation, model,
          approval_policy, sandbox_policy, created_by_slack_user_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.slackThreadId,
        "idle",
        0,
        input.model ?? null,
        input.approvalPolicy,
        input.sandboxPolicy,
        input.userId,
        now,
        now,
      );

    return {
      id,
      slackThreadId: input.slackThreadId,
      codexThreadId: null,
      state: "idle",
      activeTurnId: null,
      activeGeneration: 0,
      model: input.model ?? null,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: input.sandboxPolicy,
      createdBySlackUserId: input.userId,
    };
  }

  bindCodexThread(sessionId: string, codexThreadId: string): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
         SET codex_thread_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(codexThreadId, nowIso(), sessionId);
  }

  findSessionByCodexThreadId(codexThreadId: string): AgentSession | null {
    const row = readOptionalRow(
      this.db
      .prepare(
        `SELECT id, slack_thread_id, codex_thread_id, state, active_turn_id,
                active_generation, model, approval_policy, sandbox_policy,
                created_by_slack_user_id
         FROM agent_sessions
         WHERE codex_thread_id = ?`,
      )
        .get(codexThreadId),
      AgentSessionRowSchema,
      "agent_sessions",
    );
    return row ? mapAgentSession(row) : null;
  }

  createTurn(input: {
    sessionId: string;
    generation: number;
    userMessageTs?: string;
    inputText: string;
    classifiedIntent: string;
  }): AgentTurn | null {
    const id = newId();
    const now = nowIso();
    const preview = redactPreview(input.inputText);
    const hash = createHash("sha256").update(input.inputText).digest("hex");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db
        .prepare(
          `UPDATE agent_sessions
           SET state = 'running', active_turn_id = ?, active_generation = ?, updated_at = ?
           WHERE id = ? AND state != 'running'`,
        )
        .run(id, input.generation, now, input.sessionId);

      if (Number(claim.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }

      this.db
        .prepare(
          `INSERT INTO agent_turns (
            id, session_id, generation, user_message_ts, input_preview,
            input_hash, classified_intent, state, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.generation,
          input.userMessageTs ?? null,
          preview,
          hash,
          input.classifiedIntent,
          "running",
          now,
        );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      id,
      sessionId: input.sessionId,
      codexTurnId: null,
      generation: input.generation,
      state: "running",
    };
  }

  bindCodexTurn(turnId: string, codexTurnId: string): void {
    this.db
      .prepare("UPDATE agent_turns SET codex_turn_id = ? WHERE id = ?")
      .run(codexTurnId, turnId);
  }

  completeTurn(input: {
    sessionId: string;
    turnId: string;
    state: "completed" | "interrupted" | "failed";
    errorMessage?: string;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE agent_turns
         SET state = ?, completed_at = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(input.state, now, input.errorMessage ? redactSensitiveText(input.errorMessage) : null, input.turnId);

    this.db
      .prepare(
        `UPDATE agent_sessions
         SET state = ?, active_turn_id = NULL, updated_at = ?
         WHERE id = ? AND active_turn_id = ?`,
      )
      .run(input.state === "completed" ? "idle" : input.state, now, input.sessionId, input.turnId);
  }

  recordCodexEvent(input: {
    sessionId: string;
    turnId?: string | null;
    codexThreadId?: string | null;
    codexTurnId?: string | null;
    eventType: string;
    payload: unknown;
    generation: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO codex_events (
          id, session_id, turn_id, codex_thread_id, codex_turn_id,
          event_type, payload, generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        input.sessionId,
        input.turnId ?? null,
        input.codexThreadId ?? null,
        input.codexTurnId ?? null,
        input.eventType,
        JSON.stringify(minimizeCodexPayload(input.payload)),
        input.generation,
        nowIso(),
      );
  }

  recordDeniedApproval(input: {
    sessionId: string;
    turnId?: string | null;
    codexRequestId: string;
    requestMethod: string;
    codexItemId?: string | null;
    codexApprovalId?: string | null;
    actionType: string;
    command?: string | null;
    cwd?: string | null;
    reason?: string | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO approval_requests (
          id, session_id, turn_id, codex_request_id, request_method,
          codex_item_id, codex_approval_id, action_type, command, cwd,
          risk_level, state, requested_at, resolved_at, resolution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        input.sessionId,
        input.turnId ?? null,
        input.codexRequestId,
        input.requestMethod,
        input.codexItemId ?? null,
        input.codexApprovalId ?? null,
        input.actionType,
        input.command ? redactStoredString(input.command) : null,
        input.cwd ?? null,
        "unknown",
        "resolved",
        now,
        now,
        "decline",
      );

    this.recordAuditLog({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      action: "approval.auto_declined",
      target: input.requestMethod,
      payload: {
        codexRequestId: input.codexRequestId,
        codexItemId: input.codexItemId ?? null,
        codexApprovalId: input.codexApprovalId ?? null,
        reason: input.reason ? redactSensitiveText(input.reason) : null,
      },
    });
  }

  recordAuditLog(input: {
    actorSlackUserId?: string | null;
    sessionId?: string | null;
    turnId?: string | null;
    action: string;
    target?: string | null;
    payload?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_slack_user_id, session_id, turn_id, action, target, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        input.actorSlackUserId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.action,
        input.target ?? null,
        input.payload == null ? null : JSON.stringify(redactSensitiveValue(input.payload)),
        nowIso(),
      );
  }
}

function mapSlackThread(row: SlackThreadRow): SlackThread {
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    userId: row.user_id,
  };
}

function mapAgentSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    slackThreadId: row.slack_thread_id,
    codexThreadId: row.codex_thread_id,
    state: row.state,
    activeTurnId: row.active_turn_id,
    activeGeneration: row.active_generation,
    model: row.model,
    approvalPolicy: row.approval_policy,
    sandboxPolicy: row.sandbox_policy,
    createdBySlackUserId: row.created_by_slack_user_id,
  };
}

export function mapAgentTurn(row: AgentTurnRow): AgentTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    codexTurnId: row.codex_turn_id,
    generation: row.generation,
    state: row.state,
  };
}

function redactPreview(text: string): string {
  return redactSensitiveText(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function redactStoredString(text: string): string {
  return redactSensitiveText(text);
}

function minimizeCodexPayload(payload: unknown): unknown {
  const recordResult = v.safeParse(LooseRecordSchema, payload);
  if (!recordResult.success) {
    return payload;
  }

  const record = recordResult.output;
  const minimized: Record<string, unknown> = {};

  copyString(record, minimized, "threadId");
  copyString(record, minimized, "turnId");
  copyString(record, minimized, "itemId");
  copyNumber(record, minimized, "startedAtMs");

  if (typeof record.delta === "string") {
    minimized.deltaLength = record.delta.length;
  }

  const itemResult = v.safeParse(LooseRecordSchema, record.item);
  if (itemResult.success) {
    const item = itemResult.output;
    copyString(item, minimized, "id", "itemId");
    copyString(item, minimized, "type", "itemType");
    copyString(item, minimized, "status", "itemStatus");
    if (typeof item.command === "string") {
      minimized.commandPreview = redactStoredString(item.command).slice(0, 300);
    }
    if (typeof item.exitCode === "number") {
      minimized.exitCode = item.exitCode;
    }
  }

  const turnResult = v.safeParse(LooseRecordSchema, record.turn);
  if (turnResult.success) {
    const turn = turnResult.output;
    copyString(turn, minimized, "id", "turnId");
    copyString(turn, minimized, "status", "turnStatus");
    const items = Array.isArray(turn.items) ? turn.items : [];
    minimized.itemCount = items.length;
    const itemTypes: string[] = [];
    for (const entry of items) {
      const itemTypeResult = v.safeParse(ItemTypeSchema, entry);
      if (itemTypeResult.success) itemTypes.push(itemTypeResult.output.type);
    }
    minimized.itemTypes = itemTypes;
    const errorResult = v.safeParse(ErrorMessageSchema, turn.error);
    if (errorResult.success) {
      minimized.errorMessage = redactStoredString(errorResult.output.message).slice(0, 500);
    }
  }

  return minimized;
}

function copyString(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fromKey: string,
  toKey = fromKey,
): void {
  const value = from[fromKey];
  if (typeof value === "string") to[toKey] = value;
}

function copyNumber(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fromKey: string,
  toKey = fromKey,
): void {
  const value = from[fromKey];
  if (typeof value === "number") to[toKey] = value;
}
