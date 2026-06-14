import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as v from "valibot";
import type { Logger } from "../logger.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import {
  parseCodexNotification,
  parseCodexServerRequest,
  parseCodexTurn,
  parseCodexTurnId,
  textInput,
  ThreadResumeResponseSchema,
  ThreadStartResponseSchema,
  TurnStartResponseSchema,
  type CodexNotification,
  type CodexServerRequest,
  type CodexTurn,
  type TurnRunResult,
} from "./protocol.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";

export type CodexClientOptions = {
  command: string;
  args: string[];
  defaultCwd: string;
  defaultModel?: string;
  approvalPolicy: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  logger: Logger;
};

export type ServerRequestHandler = (
  request: CodexServerRequest,
) => Promise<unknown | undefined>;

type NotificationHandler = (notification: CodexNotification) => void;

type TurnCollector = {
  threadId: string;
  turnId: string | null;
  chunks: string[];
  resolve: (result: TurnRunResult) => void;
  reject: (error: Error) => void;
};

export class CodexClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private peer: JsonRpcPeer | null = null;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly collectors = new Set<TurnCollector>();
  private readonly options: CodexClientOptions;

  constructor(options: CodexClientOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.peer) return;

    this.proc = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LOG_FORMAT: process.env.LOG_FORMAT ?? "json",
      },
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.options.logger.debug("codex app-server stderr", { text: redactSensitiveText(text) });
    });

    const peer = new JsonRpcPeer(this.proc);
    this.peer = peer;
    peer.on("notification", (message: unknown) => {
      const notification = parseCodexNotification(message);
      if (!notification) {
        this.options.logger.warn("ignored malformed codex notification");
        return;
      }
      this.handleNotification(notification);
    });
    peer.on("server_request", (message) => {
      const request = parseCodexServerRequest(message);
      if (!request) {
        this.options.logger.warn("ignored malformed codex server request");
        return;
      }
      void this.handleServerRequest(request);
    });
    peer.on("parse_error", ({ error }) => {
      this.options.logger.warn("failed to parse codex app-server message", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    await peer.request(
      "initialize",
      {
        clientInfo: {
          name: "cxsl",
          title: "cxsl Slack Codex Agent",
          version: "0.1.0",
        },
      },
      v.unknown(),
    );
    peer.notify("initialized", {});
    this.options.logger.info("codex app-server initialized");
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.peer = null;
    this.proc = null;
    proc.kill("SIGTERM");
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.add(handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandlers.add(handler);
  }

  async startThread(input: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<{ threadId: string }> {
    const response = await this.request(
      "thread/start",
      {
        model: input.model ?? this.options.defaultModel ?? null,
        cwd: input.cwd ?? this.options.defaultCwd,
        approvalPolicy: input.approvalPolicy ?? this.options.approvalPolicy,
        sandbox: input.sandbox ?? this.options.sandbox,
        ephemeral: false,
        serviceName: "cxsl",
      },
      ThreadStartResponseSchema,
    );
    return { threadId: response.thread.id };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId }, ThreadResumeResponseSchema);
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    cwd?: string;
    clientUserMessageId?: string;
  }): Promise<TurnRunResult> {
    const collector = await this.createCollector(input.threadId);
    const response = await this.request(
      "turn/start",
      {
        threadId: input.threadId,
        clientUserMessageId: input.clientUserMessageId ?? null,
        input: [textInput(input.text)],
        cwd: input.cwd ?? this.options.defaultCwd,
      },
      TurnStartResponseSchema,
    );
    collector.turnId = response.turn.id;
    return await collector.promise;
  }

  async steerTurn(input: {
    threadId: string;
    expectedTurnId: string;
    text: string;
    clientUserMessageId?: string;
  }): Promise<void> {
    await this.request(
      "turn/steer",
      {
        threadId: input.threadId,
        expectedTurnId: input.expectedTurnId,
        clientUserMessageId: input.clientUserMessageId ?? null,
        input: [textInput(input.text)],
      },
      v.unknown(),
    );
  }

  async interruptTurn(input: { threadId: string; turnId: string }): Promise<void> {
    await this.request("turn/interrupt", input, v.unknown());
  }

  private async createCollector(threadId: string): Promise<TurnCollector & { promise: Promise<TurnRunResult> }> {
    let resolve!: (result: TurnRunResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<TurnRunResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const collector: TurnCollector & { promise: Promise<TurnRunResult> } = {
      threadId,
      turnId: null,
      chunks: [],
      resolve,
      reject,
      promise,
    };
    this.collectors.add(collector);
    return collector;
  }

  private request<const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    method: string,
    params: unknown,
    resultSchema: TSchema,
  ): Promise<v.InferOutput<TSchema>> {
    if (!this.peer) {
      throw new Error("Codex app-server is not initialized");
    }
    return this.peer.request(method, params, resultSchema);
  }

  private handleNotification(notification: CodexNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
    for (const collector of [...this.collectors]) {
      this.handleCollectorNotification(collector, notification);
    }
  }

  private handleCollectorNotification(collector: TurnCollector, notification: CodexNotification): void {
    const params = notification.params;
    if (!params || params.threadId !== collector.threadId) return;

    if (notification.method === "turn/started") {
      const turnId = parseCodexTurnId(params.turn);
      if (turnId && !collector.turnId) collector.turnId = turnId;
      return;
    }

    const notificationTurnId = typeof params.turnId === "string" ? params.turnId : null;
    if (collector.turnId && notificationTurnId && notificationTurnId !== collector.turnId) {
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : null;
      if (delta) collector.chunks.push(delta);
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = parseCodexTurn(params.turn);
      if (!turn) return;
      if (collector.turnId && turn.id !== collector.turnId) return;
      if (!collector.turnId) collector.turnId = turn.id;

      this.collectors.delete(collector);
      const text = collector.chunks.join("") || finalAgentText(turn);
      const errorMessage = turn.error?.message;
      collector.resolve({
        threadId: collector.threadId,
        turnId: turn.id,
        status: turn.status,
        text,
        errorMessage,
      });
    }
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    if (!this.peer) return;

    try {
      for (const handler of this.serverRequestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          this.peer.respond(request.id, result);
          return;
        }
      }
      this.peer.respond(request.id, defaultServerRequestResponse(request));
    } catch (error) {
      this.peer.respondError(
        request.id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function finalAgentText(turn: CodexTurn): string {
  for (const item of [...turn.items].reverse()) {
    if (item.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

function defaultServerRequestResponse(request: CodexServerRequest): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    default:
      throw new Error(`Unsupported server request: ${request.method}`);
  }
}

export function getRequestId(request: CodexServerRequest): string {
  return String(request.id);
}
