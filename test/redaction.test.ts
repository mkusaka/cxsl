import test from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { redactSensitiveText, redactSensitiveValue } from "../src/security/redaction.ts";

const FAKE_SLACK_BOT_TOKEN = "xox" + "b-secret-value";
const FAKE_SLACK_APP_TOKEN = "xap" + "p-secret-value";
const FAKE_GITHUB_PAT = "github" + "_pat_secretvalue";
const FAKE_GHP_TOKEN = "gh" + "p_secretvalue";

const NestedTokenSchema = v.object({
  nested: v.object({
    token: v.string(),
  }),
});

test("redactSensitiveText redacts common token formats", () => {
  const input = [
    `SLACK_BOT_TOKEN=${FAKE_SLACK_BOT_TOKEN}`,
    `SLACK_APP_TOKEN=${FAKE_SLACK_APP_TOKEN}`,
    "Authorization: Bearer secret-token",
    "x-access-token:secret-token",
    FAKE_GITHUB_PAT,
    FAKE_GHP_TOKEN,
    "OPENAI_API_KEY=sk-secret-secret-secret-secret",
    "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
  ].join(" ");

  const output = redactSensitiveText(input);

  assert.equal(output.includes(FAKE_SLACK_BOT_TOKEN), false);
  assert.equal(output.includes(FAKE_SLACK_APP_TOKEN), false);
  assert.doesNotMatch(output, /secret-token/);
  assert.equal(output.includes(FAKE_GITHUB_PAT), false);
  assert.equal(output.includes(FAKE_GHP_TOKEN), false);
  assert.doesNotMatch(output, /sk-secret/);
  assert.doesNotMatch(output, /AKIA1234567890ABCDEF/);
  assert.match(output, /<redacted>/);
});

test("redactSensitiveValue redacts nested values", () => {
  const output = v.parse(NestedTokenSchema, redactSensitiveValue({
    nested: {
      token: `SLACK_APP_TOKEN=${FAKE_SLACK_APP_TOKEN}`,
    },
  }));

  assert.equal(output.nested.token, "SLACK_APP_TOKEN=<redacted>");
});
