import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  slackBotToken: string;
  slackAppToken: string;
  databasePath: string;
  codexCommand: string;
  codexArgs: string[];
  codexDefaultCwd: string;
  codexDefaultModel?: string;
  codexApprovalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  logLevel: "debug" | "info" | "warn" | "error";
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalCsv(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return ["app-server"];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall back to a simple whitespace split for local development.
  }
  return value.split(/\s+/).filter(Boolean);
}

function oneOf<const T extends readonly string[]>(name: string, fallback: T[number], allowed: T): T[number] {
  const value = process.env[name] ?? fallback;
  if (includesValue(allowed, value)) return value;
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function includesValue<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return allowed.some((entry) => entry === value);
}

export function loadConfig(): AppConfig {
  const databasePath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(repoRoot, ".data", "cxsl.sqlite");

  return {
    slackBotToken: requiredEnv("SLACK_BOT_TOKEN"),
    slackAppToken: requiredEnv("SLACK_APP_TOKEN"),
    databasePath,
    codexCommand: process.env.CODEX_COMMAND ?? "codex",
    codexArgs: parseArgs(process.env.CODEX_ARGS),
    codexDefaultCwd: path.resolve(process.env.CODEX_DEFAULT_CWD ?? repoRoot),
    codexDefaultModel: process.env.CODEX_DEFAULT_MODEL || undefined,
    codexApprovalPolicy: oneOf("CODEX_APPROVAL_POLICY", "on-request", [
      "untrusted",
      "on-failure",
      "on-request",
      "never",
    ] as const),
    codexSandbox: oneOf("CODEX_SANDBOX", "workspace-write", [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ] as const),
    allowedUserIds: optionalCsv("SLACK_ALLOWED_USER_IDS"),
    allowedChannelIds: optionalCsv("SLACK_ALLOWED_CHANNEL_IDS"),
    logLevel: oneOf("LOG_LEVEL", "info", ["debug", "info", "warn", "error"] as const),
  };
}
