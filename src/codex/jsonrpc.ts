import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as v from "valibot";
import {
  JsonRpcMessageSchema,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.ts";

type PendingRequest = {
  resolve: (input: unknown) => void;
  reject: (error: Error) => void;
};

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly proc: ChildProcessWithoutNullStreams;

  constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.proc = proc;
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.handleLine(line));
    proc.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
  }

  request<const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    method: string,
    params: unknown,
    resultSchema: TSchema,
  ): Promise<v.InferOutput<TSchema>> {
    const id = this.nextId++;
    const payload = { id, method, params };
    const parseResult = v.parser(resultSchema);
    const promise = new Promise<v.InferOutput<TSchema>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (input) => {
          try {
            resolve(parseResult(input));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
      });
    });
    this.write(payload);
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.write({ id, error: { code, message, data } });
  }

  private write(payload: unknown): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = v.parse(JsonRpcMessageSchema, JSON.parse(line));
    } catch (error) {
      this.emit("parse_error", { line, error });
      return;
    }

    const maybeId = "id" in message ? message.id : undefined;
    const maybeMethod = "method" in message ? message.method : undefined;

    if (maybeId != null && maybeMethod) {
      this.emit("server_request", message);
      return;
    }

    if (maybeId != null) {
      const pending = this.pending.get(maybeId);
      if (!pending) {
        this.emit("orphan_response", message);
        return;
      }
      this.pending.delete(maybeId);
      if ("error" in message) {
        pending.reject(new Error(message.error.message));
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error("Malformed JSON-RPC response"));
      }
      return;
    }

    if (maybeMethod) {
      this.emit("notification", message);
    }
  }
}
