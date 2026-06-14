import * as v from "valibot";

export const UnknownRecordSchema = v.looseObject({});

export const JsonRpcIdSchema = v.union([v.number(), v.string()]);
export type JsonRpcId = v.InferOutput<typeof JsonRpcIdSchema>;

const JsonRpcErrorSchema = v.object({
  code: v.optional(v.number(), -32603),
  message: v.string(),
  data: v.optional(v.unknown()),
});

export const JsonRpcRequestSchema = v.object({
  id: v.optional(JsonRpcIdSchema),
  method: v.string(),
  params: v.optional(v.unknown()),
});

export const JsonRpcResponseSchema = v.union([
  v.object({
    id: JsonRpcIdSchema,
    result: v.unknown(),
  }),
  v.object({
    id: JsonRpcIdSchema,
    error: JsonRpcErrorSchema,
  }),
]);

export const JsonRpcMessageSchema = v.union([
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
]);

export type JsonRpcResponse<T = unknown> =
  | { id: JsonRpcId; result: T }
  | { id: JsonRpcId; error: v.InferOutput<typeof JsonRpcErrorSchema> };

export type JsonRpcMessage = v.InferOutput<typeof JsonRpcMessageSchema>;

export const CodexNotificationSchema = v.object({
  method: v.string(),
  params: v.optional(UnknownRecordSchema),
});
export type CodexNotification = v.InferOutput<typeof CodexNotificationSchema>;

export const CodexServerRequestSchema = v.object({
  id: JsonRpcIdSchema,
  method: v.string(),
  params: v.optional(UnknownRecordSchema),
});
export type CodexServerRequest = v.InferOutput<typeof CodexServerRequestSchema>;

export const ThreadStartResponseSchema = v.object({
  thread: v.object({
    id: v.string(),
  }),
});
export type ThreadStartResponse = v.InferOutput<typeof ThreadStartResponseSchema>;

export const ThreadResumeResponseSchema = ThreadStartResponseSchema;
export type ThreadResumeResponse = v.InferOutput<typeof ThreadResumeResponseSchema>;

const CodexThreadItemSchema = v.looseObject({
  type: v.string(),
  id: v.optional(v.string()),
  text: v.optional(v.string()),
});
export type CodexThreadItem = v.InferOutput<typeof CodexThreadItemSchema>;

export const CodexTurnSchema = v.object({
  id: v.string(),
  status: v.picklist(["completed", "interrupted", "failed", "inProgress"]),
  items: v.optional(v.array(CodexThreadItemSchema), []),
  error: v.optional(
    v.nullable(v.object({
      message: v.optional(v.string()),
    })),
    null,
  ),
});
export type CodexTurn = v.InferOutput<typeof CodexTurnSchema>;

export const TurnStartResponseSchema = v.object({
  turn: CodexTurnSchema,
});
export type TurnStartResponse = v.InferOutput<typeof TurnStartResponseSchema>;

const CodexTurnIdSchema = v.object({
  id: v.string(),
});

export type TurnRunResult = {
  threadId: string;
  turnId: string;
  status: CodexTurn["status"];
  text: string;
  errorMessage?: string;
};

export type UserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };

export function textInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}

export function parseCodexNotification(input: unknown): CodexNotification | null {
  const result = v.safeParse(CodexNotificationSchema, input);
  return result.success ? result.output : null;
}

export function parseCodexServerRequest(input: unknown): CodexServerRequest | null {
  const result = v.safeParse(CodexServerRequestSchema, input);
  return result.success ? result.output : null;
}

export function parseCodexTurn(input: unknown): CodexTurn | null {
  const result = v.safeParse(CodexTurnSchema, input);
  return result.success ? result.output : null;
}

export function parseCodexTurnId(input: unknown): string | null {
  const result = v.safeParse(CodexTurnIdSchema, input);
  return result.success ? result.output.id : null;
}
