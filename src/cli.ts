#!/usr/bin/env node
import { Command } from "commander";

import { enforceCapacityForNewWork, getCapacityStatus } from "./capacity.js";
import { CodexClient } from "./codex.js";
import { ensureProjectStructure, loadAppConfig, loadRepoProfile, listRepoProfiles } from "./config.js";
import { StateDatabase } from "./db.js";
import { syncOpenIssues } from "./github.js";
import { buildIssueGraph } from "./issue-graph.js";
import { createLogger } from "./logging.js";
import { createLockManager } from "./locks.js";
import { runOnce } from "./pipeline.js";
import { commandToString } from "./command-config.js";
import { NodeCommandRunner } from "./shell.js";
import { listReadyIssues, nextReadyIssue } from "./scheduler.js";
import { watchPullRequests } from "./watchers.js";
import { runWorkerLoop } from "./runner-loop.js";

const program = new Command();
program
  .name("issue-engine")
  .description("General-purpose GitHub issue orchestrator for Codex-driven worktrees")
  .version("0.1.0");

program
  .command("doctor")
  .description("Check local prerequisites and validate project configuration")
  .action(async () => {
    const appConfig = loadAppConfig();
    ensureProjectStructure(appConfig);
    const logger = createLogger({
      rootDir: appConfig.paths.rootDir,
      level: appConfig.logLevel,
    });
    const runner = new NodeCommandRunner();
    const db = new StateDatabase(appConfig.paths.dbPath);
    db.migrate();

    try {
      await runner.run("node", ["-v"]);
      await runner.run("git", ["--version"]);
      await runner.run("gh", ["--version"]);
      await runner.run("codex", ["exec", "--help"]);

      const profiles = listRepoProfiles(appConfig);
      for (const profileName of profiles) {
        loadRepoProfile(appConfig, profileName);
      }

      logger.info(`Doctor passed. Profiles validated: ${profiles.length}`);
      console.log(`DB: ${appConfig.paths.dbPath}`);
      console.log(`Profiles: ${profiles.join(", ") || "(none)"}`);
      console.log(
        `Capacity gate: ${
          appConfig.capacityCheck?.enabled
            ? commandToString(appConfig.capacityCheck.command)
            : "(disabled)"
        }`,
      );
    } finally {
      db.close();
    }
  });

program
  .command("init")
  .description("Create runtime directories and initialize the SQLite state database")
  .action(() => {
    const appConfig = loadAppConfig();
    ensureProjectStructure(appConfig);
    const db = new StateDatabase(appConfig.paths.dbPath);
    db.migrate();
    db.close();
    console.log(`Initialized project structure under ${appConfig.paths.rootDir}`);
    console.log(`SQLite DB ready at ${appConfig.paths.dbPath}`);
  });

program
  .command("check-capacity")
  .description("Run the configured capacity status command and report remaining headroom")
  .action(async () => {
    const appConfig = loadAppConfig();
    ensureProjectStructure(appConfig);
    const runner = new NodeCommandRunner();
    const status = await getCapacityStatus(appConfig, runner);

    if (!status.enabled) {
      console.log("Capacity gate disabled");
      return;
    }

    console.log(
      JSON.stringify(
        {
          enabled: status.enabled,
          available: status.available,
          remainingPercent: status.remainingPercent,
          usedPercent: status.usedPercent,
          thresholdPercent: status.thresholdPercent,
          shouldBlockNewWork: status.shouldBlockNewWork,
          windowLabel: status.windowLabel,
          sourceCommand: status.sourceCommand,
          reason: status.reason,
          rawOutput: status.rawOutput,
        },
        null,
        2,
      ),
    );
  });

program
  .command("sync-issues")
  .requiredOption("--profile <name>", "Repo profile name")
  .description("Sync open GitHub issues into local state")
  .action(async (options: { profile: string }) => {
    const context = createCommandContext(options.profile);
    try {
      const issues = await syncOpenIssues(
        context.runner,
        context.db,
        context.profile,
        context.logger,
      );
      console.log(`Synced ${issues.length} open issues for ${context.profile.profileName}`);
    } finally {
      context.db.close();
    }
  });

program
  .command("build-graph")
  .requiredOption("--profile <name>", "Repo profile name")
  .description("Infer issue dependency and epic/subtask edges")
  .action(async (options: { profile: string }) => {
    const context = createCommandContext(options.profile);
    try {
      const issues =
        context.db.getIssues(context.profile.profileName, "OPEN").length > 0
          ? context.db.getIssues(context.profile.profileName, "OPEN")
          : await syncOpenIssues(
              context.runner,
              context.db,
              context.profile,
              context.logger,
            );
      const edges = await buildIssueGraph(
        context.profile,
        issues,
        context.logger,
        context.profile.llmDependencyNormalization?.enabled
          ? context.codex.createDependencyNormalizer()
          : undefined,
      );
      context.db.replaceIssueEdges(context.profile.profileName, edges);
      console.log(`Built ${edges.length} issue edges for ${context.profile.profileName}`);
    } finally {
      context.db.close();
    }
  });

program
  .command("list-ready")
  .requiredOption("--profile <name>", "Repo profile name")
  .description("List ready-to-run issues")
  .action((options: { profile: string }) => {
    const context = createCommandContext(options.profile);
    try {
      const issues = context.db.getIssues(context.profile.profileName, "OPEN");
      const edges = context.db.getIssueEdges(context.profile.profileName);
      const activeIssueNumbers = new Set(
        context.db.getActiveRuns(context.profile.profileName).map((run) => run.issueNumber),
      );
      const lockedIssueNumbers = new Set(
        context.db.getActiveLocks(context.profile.profileName).map((lock) => lock.issueNumber),
      );
      const ready = listReadyIssues(
        context.profile,
        issues,
        edges,
        activeIssueNumbers,
        lockedIssueNumbers,
      );

      if (ready.length === 0) {
        console.log(`No ready issues for ${context.profile.profileName}`);
        return;
      }

      for (const candidate of ready) {
        console.log(
          `#${candidate.issue.number} score=${candidate.score} priority=${candidate.issue.priority} ${candidate.issue.title}`,
        );
      }
    } finally {
      context.db.close();
    }
  });

program
  .command("claim-next")
  .requiredOption("--profile <name>", "Repo profile name")
  .description("Lease the next ready issue without starting a run")
  .action(async (options: { profile: string }) => {
    const context = createCommandContext(options.profile);
    try {
      await enforceCapacityForNewWork(context.appConfig, context.runner, context.logger);
      const candidate = nextReadyIssue(context.db, context.profile);
      if (!candidate) {
        console.log(`No ready issue available for ${context.profile.profileName}`);
        return;
      }

      const locks = createLockManager(
        context.db,
        context.profile.profileName,
        context.appConfig.defaultLockLeaseMs,
      );
      const owner = `manual-claim:${process.pid}`;
      const acquired = locks.acquire(candidate.issue.number, owner);
      if (!acquired) {
        throw new Error(`Issue #${candidate.issue.number} could not be claimed`);
      }

      console.log(
        `Claimed issue #${candidate.issue.number} for ${context.profile.profileName} with owner ${owner}`,
      );
    } finally {
      context.db.close();
    }
  });

program
  .command("run-once")
  .requiredOption("--profile <name>", "Repo profile name")
  .option("--issue <number>", "Specific issue number", parseInteger)
  .option("--dry-run", "Do not mutate any target repo state", false)
  .description("Run a single scheduling + Codex implementation pipeline")
  .action(async (options: { profile: string; issue?: number; dryRun: boolean }) => {
    const context = createCommandContext(options.profile);
    try {
      const result = await runOnce({
        profile: context.profile,
        appConfig: context.appConfig,
        db: context.db,
        logger: context.logger,
        runner: context.runner,
        codex: context.codex,
        dryRun: options.dryRun,
        issueNumber: options.issue,
      });

      console.log(
        `${options.dryRun ? "Dry-run completed" : "Run completed"} for issue #${result.issue.number}`,
      );
      console.log(`Branch: ${result.branchName}`);
      console.log(`Worktree: ${result.worktreePath}`);
      if (result.pr) {
        console.log(`PR: ${result.pr.url}`);
      }
    } finally {
      context.db.close();
    }
  });

program
  .command("watch-prs")
  .requiredOption("--profile <name>", "Repo profile name")
  .description("Poll orchestrator-created PRs and queue repair runs when needed")
  .action(async (options: { profile: string }) => {
    const context = createCommandContext(options.profile);
    try {
      await watchPullRequests(
        context.runner,
        context.db,
        context.profile,
        context.logger,
      );
    } finally {
      context.db.close();
    }
  });

program
  .command("run-worker")
  .requiredOption("--profile <name>", "Repo profile name")
  .option("--interval-ms <milliseconds>", "Polling interval in milliseconds", parseInteger, 30_000)
  .option("--parallel <n>", "Number of in-process workers", parseInteger, 1)
  .option("--max-runs <n>", "Stop after this many runs (optional)", parseInteger)
  .option("--issue <number>", "Specific issue number")
  .option("--dry-run", "Do not mutate any target repo state", false)
  .description("Run queued work and continuously process ready issues")
  .action(async (options: { profile: string; intervalMs: number; parallel: number; maxRuns?: number; issue?: number; dryRun: boolean }) => {
    if (options.intervalMs <= 0) {
      throw new Error("interval-ms must be greater than 0");
    }
    if (options.parallel <= 0) {
      throw new Error("parallel must be greater than 0");
    }
    if (options.maxRuns !== undefined && options.maxRuns <= 0) {
      throw new Error("max-runs must be greater than 0");
    }

    const context = createCommandContext(options.profile);
    const stopController = new AbortController();
    const onStop = (signal: string): void => {
      context.logger.warn(`Received ${signal}; shutting down worker loop`);
      stopController.abort();
    };
    process.once("SIGINT", () => onStop("SIGINT"));
    process.once("SIGTERM", () => onStop("SIGTERM"));

    try {
      await runWorkerLoop({
        profile: context.profile,
        appConfig: context.appConfig,
        db: context.db,
        logger: context.logger,
        runner: context.runner,
        codex: context.codex,
        intervalMs: options.intervalMs,
        parallel: options.parallel,
        maxRuns: options.maxRuns,
        issueNumber: options.issue,
        dryRun: options.dryRun,
        stopSignal: stopController.signal,
      });
    } finally {
      context.db.close();
    }
  });

program
  .command("release-lock")
  .requiredOption("--profile <name>", "Repo profile name")
  .requiredOption("--issue <number>", "Issue number", parseInteger)
  .description("Release a lock for an issue")
  .action((options: { profile: string; issue: number }) => {
    const context = createCommandContext(options.profile);
    try {
      context.db.releaseLock(context.profile.profileName, options.issue);
      console.log(`Released lock for issue #${options.issue}`);
    } finally {
      context.db.close();
    }
  });

program
  .command("show-issue")
  .requiredOption("--profile <name>", "Repo profile name")
  .requiredOption("--issue <number>", "Issue number", parseInteger)
  .description("Show local state for one issue")
  .action((options: { profile: string; issue: number }) => {
    const context = createCommandContext(options.profile);
    try {
      const issue = context.db.getIssue(context.profile.profileName, options.issue);
      if (!issue) {
        throw new Error(`Issue #${options.issue} not found`);
      }

      const edges = context.db
        .getIssueEdges(context.profile.profileName)
        .filter(
          (edge) =>
            edge.fromIssue === options.issue || edge.toIssue === options.issue,
        );
      const locks = context.db
        .getActiveLocks(context.profile.profileName)
        .filter((lock) => lock.issueNumber === options.issue);
      const runs = context.db.getIssueRuns(context.profile.profileName, options.issue);

      console.log(JSON.stringify({ issue, edges, locks, runs }, null, 2));
    } finally {
      context.db.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});

function createCommandContext(profileName: string) {
  const appConfig = loadAppConfig();
  ensureProjectStructure(appConfig);
  const logger = createLogger({
    rootDir: appConfig.paths.rootDir,
    level: appConfig.logLevel,
  });
  const db = new StateDatabase(appConfig.paths.dbPath);
  db.migrate();
  const runner = new NodeCommandRunner();
  const codex = new CodexClient(appConfig, runner, logger);
  const profile = loadRepoProfile(appConfig, profileName);
  return {
    appConfig,
    logger,
    db,
    runner,
    codex,
    profile,
  };
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}
