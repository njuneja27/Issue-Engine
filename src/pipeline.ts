import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { enforceCapacityForNewWork } from "./capacity.js";
import type { StateDatabase } from "./db.js";
import { syncOpenIssues } from "./github.js";
import { buildIssueGraph } from "./issue-graph.js";
import type { Logger } from "./logging.js";
import { createLockManager } from "./locks.js";
import { buildImplementerPrompt, buildPlannerPrompt, buildReviewerPrompt, renderValidationSummary } from "./prompting.js";
import { commitAndPush, createDraftPr, listChangedPaths } from "./prs.js";
import type { CommandRunner } from "./shell.js";
import { listReadyIssues, nextReadyIssue } from "./scheduler.js";
import type { CodexClient } from "./codex.js";
import type { GitHubIssue, PullRequestRecord, RepoProfile, RunRecord } from "./types.js";
import { selectValidationCommands, runValidationCommands } from "./validation.js";
import { prepareWorktree } from "./worktrees.js";
import { ensureDir, nowIso, randomId } from "./utils.js";

export interface RunOnceOptions {
  profile: RepoProfile;
  appConfig: AppConfig;
  db: StateDatabase;
  logger: Logger;
  runner: CommandRunner;
  codex: CodexClient;
  dryRun: boolean;
  issueNumber?: number | undefined;
}

export interface RunOnceResult {
  runId: string;
  issue: GitHubIssue;
  branchName: string;
  worktreePath: string;
  pr?: PullRequestRecord | undefined;
  dryRun: boolean;
  validationResults: Array<{ name: string; command: string; status: "passed" | "failed" | "skipped" }>;
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { profile, appConfig, db, logger, runner, codex, dryRun } = options;

  if (!dryRun) {
    await enforceCapacityForNewWork(appConfig, runner, logger);
  }

  const issues = await syncOpenIssues(runner, db, profile, logger);
  const edges = await buildIssueGraph(
    profile,
    issues,
    logger,
    !dryRun && profile.llmDependencyNormalization?.enabled
      ? codex.createDependencyNormalizer()
      : undefined,
  );
  db.replaceIssueEdges(profile.profileName, edges);

  const issue = selectIssue(db, profile, options.issueNumber);
  const runId = randomId(`run-${profile.profileName}-issue-${issue.number}`);
  const owner = `issue-engine:${process.pid}`;
  const runDir = join(appConfig.paths.runLogDir, runId);
  ensureDir(runDir);

  const lockManager = createLockManager(db, profile.profileName, appConfig.defaultLockLeaseMs);
  if (!lockManager.acquire(issue.number, owner)) {
    throw new Error(`Issue #${issue.number} is already locked`);
  }

  const runRecord: RunRecord = {
    runId,
    profileName: profile.profileName,
    issueNumber: issue.number,
    phase: "planning",
    status: "running",
    dryRun,
    startedAt: nowIso(),
    metadata: {},
  };
  db.insertRun(runRecord);

  try {
    const validationSummary = renderValidationSummary(profile);
    const worktree = await prepareWorktree(runner, db, profile, issue, logger, dryRun);
    db.updateRun(runId, {
      branchName: worktree.branchName,
      worktreePath: worktree.path,
      metadata: {
        reusedWorktree: worktree.reused,
      },
    });
    lockManager.heartbeat(issue.number, owner);

    const plannerPrompt = buildPlannerPrompt(
      appConfig,
      profile,
      issue,
      worktree.branchName,
      validationSummary,
    );
    const planner = await codex.runPlanner(
      profile,
      plannerPrompt,
      runDir,
      dryRun ? appConfig.paths.rootDir : worktree.path,
      dryRun,
    );
    db.updateRun(runId, {
      phase: "review",
      metadata: {
        plannerModel: planner.modelUsed,
        promptPath: planner.promptPath,
        plannerResponsePath: planner.responsePath,
      },
    });
    lockManager.heartbeat(issue.number, owner);

    const reviewerPrompt = buildReviewerPrompt(
      appConfig,
      profile,
      issue,
      planner.output,
      validationSummary,
    );
    const reviewer = await codex.runReviewer(
      profile,
      reviewerPrompt,
      runDir,
      dryRun ? appConfig.paths.rootDir : worktree.path,
      dryRun,
    );
    const reconciledPlan = codex.reconcilePlan(planner.output, reviewer.output);
    db.updateRun(runId, {
      phase: "implementation",
      metadata: {
        plannerModel: planner.modelUsed,
        reviewerModel: reviewer.modelUsed,
        reviewerResponsePath: reviewer.responsePath,
      },
    });
    lockManager.heartbeat(issue.number, owner);

    const implementerPrompt = buildImplementerPrompt(
      appConfig,
      profile,
      issue,
      worktree.branchName,
      reconciledPlan,
      validationSummary,
    );
    const implementer = await codex.runImplementer(
      profile,
      implementerPrompt,
      runDir,
      dryRun ? appConfig.paths.rootDir : worktree.path,
      dryRun,
    );

    const changedPaths = dryRun
      ? implementer.output.changedFiles
      : await listChangedPaths(runner, worktree.path);
    const validationCommands = selectValidationCommands(profile, changedPaths);
    const validationResults = await runValidationCommands(
      runner,
      profile,
      worktree.path,
      validationCommands,
      logger,
      dryRun,
    );

    const commitResult = await commitAndPush(
      runner,
      profile,
      issue,
      worktree.path,
      worktree.branchName,
      logger,
      dryRun,
    );

    let pr: PullRequestRecord | undefined;
    if (dryRun || commitResult.changedPaths.length > 0 || implementer.output.status === "implemented") {
      pr = await createDraftPr(
        runner,
        profile,
        issue,
        runId,
        worktree.branchName,
        worktree.path,
        runDir,
        logger,
        dryRun,
      );
      if (pr) {
        db.upsertPr(pr);
      }
    }

    db.updateRun(runId, {
      phase: "implementation",
      status: "succeeded",
      endedAt: nowIso(),
      metadata: {
        plannerModel: planner.modelUsed,
        reviewerModel: reviewer.modelUsed,
        implementerModel: implementer.modelUsed,
        changedPaths,
        validationResults,
        prUrl: pr?.url,
      },
    });

    return {
      runId,
      issue,
      branchName: worktree.branchName,
      worktreePath: worktree.path,
      pr,
      dryRun,
      validationResults,
    };
  } catch (error) {
    db.updateRun(runId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    lockManager.release(issue.number, owner);
  }
}

function selectIssue(
  db: StateDatabase,
  profile: RepoProfile,
  requestedIssueNumber?: number,
): GitHubIssue {
  if (requestedIssueNumber !== undefined) {
    const requested = db.getIssue(profile.profileName, requestedIssueNumber);
    if (!requested || requested.state !== "OPEN") {
      throw new Error(`Issue #${requestedIssueNumber} is not open in local state`);
    }

    const issues = db.getIssues(profile.profileName, "OPEN");
    const edges = db.getIssueEdges(profile.profileName);
    const activeIssueNumbers = new Set(
      db.getActiveRuns(profile.profileName).map((run) => run.issueNumber),
    );
    const lockedIssueNumbers = new Set(
      db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
    );
    const ready = listReadyIssues(
      profile,
      issues,
      edges,
      activeIssueNumbers,
      lockedIssueNumbers,
    );
    const candidate = ready.find((item) => item.issue.number === requestedIssueNumber);
    if (!candidate) {
      throw new Error(`Issue #${requestedIssueNumber} is not currently ready to run`);
    }
    return requested;
  }

  const next = nextReadyIssue(db, profile);
  if (!next) {
    throw new Error(`No ready issue found for profile ${profile.profileName}`);
  }
  return next.issue;
}
