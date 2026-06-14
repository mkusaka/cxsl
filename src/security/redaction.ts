const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTHORIZATION_PATTERN = /Authorization:\s*Bearer\s+\S+/gi;
const X_ACCESS_TOKEN_PATTERN = /x-access-token:\S+/gi;
const GITHUB_PAT_PATTERN = /github_pat_[A-Za-z0-9_]+/g;
const GITHUB_TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9_]+/g;
const SLACK_TOKEN_PATTERN = /x(?:ox[baprs]|app)-[A-Za-z0-9-]+/g;
const OPENAI_TOKEN_PATTERN = /sk-[A-Za-z0-9_-]{20,}/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|AUTH)[A-Z0-9_]*)=([^\s"'`]+)/gi;

export function redactSensitiveText(text: string): string {
  return text
    .replace(PRIVATE_KEY_PATTERN, "<redacted-private-key>")
    .replace(AUTHORIZATION_PATTERN, "Authorization: Bearer <redacted>")
    .replace(X_ACCESS_TOKEN_PATTERN, "x-access-token:<redacted>")
    .replace(GITHUB_PAT_PATTERN, "<redacted>")
    .replace(GITHUB_TOKEN_PATTERN, "<redacted>")
    .replace(SLACK_TOKEN_PATTERN, "<redacted>")
    .replace(OPENAI_TOKEN_PATTERN, "<redacted>")
    .replace(AWS_ACCESS_KEY_PATTERN, "<redacted>")
    .replace(GENERIC_SECRET_ASSIGNMENT_PATTERN, "$1=<redacted>");
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactSensitiveValue(entry);
  }
  return redacted;
}
