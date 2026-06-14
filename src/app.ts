import { loadConfig } from "./config.ts";
import { CodexClient } from "./codex/client.ts";
import { openDatabase } from "./db/database.ts";
import { Repositories } from "./db/repositories.ts";
import { Logger } from "./logger.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { createSlackApp } from "./slack/bolt.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const db = openDatabase(config.databasePath);
  const repos = new Repositories(db);
  const codex = new CodexClient({
    command: config.codexCommand,
    args: config.codexArgs,
    defaultCwd: config.codexDefaultCwd,
    defaultModel: config.codexDefaultModel,
    approvalPolicy: config.codexApprovalPolicy,
    sandbox: config.codexSandbox,
    logger,
  });

  await codex.start();
  const orchestrator = new Orchestrator(config, repos, codex, logger);
  const slack = createSlackApp(config, orchestrator, logger);

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await slack.stop();
    await codex.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await slack.start();
  logger.info("cxsl started", {
    databasePath: config.databasePath,
    codexCommand: config.codexCommand,
    codexArgs: config.codexArgs,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
