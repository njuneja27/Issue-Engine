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
import type { GitHubIssue, IssueEdge, PullRequestRecord, RepoProfile, RunRecord } from "./types.js";
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
  runOwner?: string | undefined;
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

export interface RunIssueOptions {
  profile: RepoProfile;
  appConfig: AppConfig;
  db: StateDatabase;
  logger: Logger;
  runner: CommandRunner;
  codex: CodexClient;
  issue: GitHubIssue;
  dryRun: boolean;
  runId?: string | undefined;
  runOwner?: string | undefined;
  requireIssueReady?: boolean | undefined;
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { profile, appConfig, db, logger, runner, codex, dryRun } = options;
  const issue = selectIssue(db, profile, options.issueNumber);
  const runId = randomId(`run-${options.profile.profileName}-issue-${issue.number}`);

  return runIssue({
    profile,
    appConfig,
    db,
    logger,
    runner,
    codex,
    dryRun,
    runOwner,
    runId,
    issue,
    runOwner: runOwner ?? `issue-engine:${process.pid}`,
    requireIssueReady: true,
  });
}

export async function runIssue(options: RunIssueOptions): Promise<RunOnceResult> {
  const {
    profile,
    appConfig,
    db,
    logger,
    runner,
    codex,
    issue,
    dryRun,
    runId,
    runOwner,
    requireIssueReady,
  } = options;
  const effectiveRunId = runId ?? randomId(`run-${profile.profileName}-issue-${issue.number}`);
  const owner = runOwner ?? `issue-engine:${process.pid}`;
  const runLabel = `[run ${effectiveRunId}]`;

  if (!dryRun) {
    await enforceCapacityForNewWork(appConfig, runner, logger);
  }

  logger.info(
    `${runLabel} starting ${dryRun ? "dry-run" : "real"} run for issue #${issue.number} in profile ${profile.profileName} (owner=${owner})`,
  );

  logger.info(`${runLabel} syncing open issues`);
  const issues = await syncOpenIssues(runner, db, profile, logger);
  logger.info(`${runLabel} synced ${issues.length} open issues`);
  logger.info(`${runLabel} rebuilding issue graph`);
  const edges = await buildIssueGraph(
    profile,
    issues,
    logger,
    !dryRun && profile.llmDependencyNormalization?.enabled
      ? codex.createDependencyNormalizer()
      : undefined,
  );
  db.replaceIssueEdges(profile.profileName, edges);

  const selectedIssue = selectIssue(
    db,
    profile,
    issue.number,
    issues,
    edges,
    requireIssueReady ?? false,
  );
  logger.info(`${runLabel} selected issue #${selectedIssue.number}`);
  const runDir = join(appConfig.paths.runLogDir, effectiveRunId);
  ensureDir(runDir);

  const lockManager = createLockManager(db, profile.profileName, appConfig.defaultLockLeaseMs);
  if (!lockManager.acquire(selectedIssue.number, owner)) {
    throw new Error(`Issue #${selectedIssue.number} is already locked`);
  }
  logger.info(`${runLabel} lock acquired for issue #${selectedIssue.number}`);

  if (runId) {
    const existingRun = db.getRun(runId);
    if (!existingRun) {
      throw new Error(`Run ${runId} not found`);
    }

    db.updateRun(runId, {
      status: "running",
      phase: "planning",
      dryRun,
      startedAt: existingRun.startedAt,
      metadata: {
        ...(existingRun.metadata ?? {}),
        queuedPhase: existingRun.phase,
        resumedBy: owner,
      },
    });
    logger.info(`${runLabel} resumed run ${runId} from ${existingRun.phase}`);
  } else {
    const runRecord: RunRecord = {
      runId: effectiveRunId,
      profileName: profile.profileName,
      issueNumber: selectedIssue.number,
      phase: "planning",
      status: "running",
      dryRun,
      startedAt: nowIso(),
      metadata: {
        runOwner: owner,
      },
    };
    db.insertRun(runRecord);
    logger.info(`${runLabel} created run record`);
  }

  try {
    logger.info(`${runLabel} preparing worktree`);
    const validationSummary = renderValidationSummary(profile);
    const worktree = await prepareWorktree(runner, db, profile, selectedIssue, logger, dryRun);
    db.updateRun(effectiveRunId, {
      phase: "planning",
      worktreePath: worktree.path,
      metadata: {
        reusedWorktree: worktree.reused,
      },
    });
    logger.info(
      `${runLabel} worktree ready at ${worktree.path} (${worktree.reused ? "reused" : "new"})`,
    );
    lockManager.heartbeat(selectedIssue.number, owner);

    logger.info(`${runLabel} entering planner phase`);
    const plannerPrompt = buildPlannerPrompt(
      appConfig,
      profile,
      selectedIssue,
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
    db.updateRun(effectiveRunId, {
      phase: "review",
      metadata: {
        plannerModel: planner.modelUsed,
        promptPath: planner.promptPath,
        plannerResponsePath: planner.responsePath,
      },
    });
    lockManager.heartbeat(selectedIssue.number, owner);

    logger.info(`${runLabel} entering review phase`);
    const reviewerPrompt = buildReviewerPrompt(
      appConfig,
      profile,
      selectedIssue,
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
    db.updateRun(effectiveRunId, {
      phase: "implementation",
      metadata: {
        plannerModel: planner.modelUsed,
        reviewerModel: reviewer.modelUsed,
        reviewerResponsePath: reviewer.responsePath,
      },
    });
    lockManager.heartbeat(selectedIssue.number, owner);

    logger.info(`${runLabel} entering implementation phase`);
    const implementerPrompt = buildImplementerPrompt(
      appConfig,
      profile,
      selectedIssue,
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
    logger.info(
      `${runLabel} implementation completed with status ${implementer.output.status} (${implementer.output.changedFiles.length} changed file(s))`,
    );

    const changedPaths = dryRun
      ? implementer.output.changedFiles
      : await listChangedPaths(runner, worktree.path);
    const validationCommands = selectValidationCommands(profile, changedPaths);
    logger.info(
      `${runLabel} running validation (${validationCommands.length} command(s)) on ${changedPaths.length} changed path(s)`,
    );
    const validationResults = await runValidationCommands(
      runner,
      profile,
      worktree.path,
      validationCommands,
      logger,
      dryRun,
    );

    logger.info(`${runLabel} committing/pushing changes if needed`);
    const commitResult = await commitAndPush(
      runner,
      profile,
      selectedIssue,
      worktree.path,
      worktree.branchName,
      logger,
      dryRun,
    );

    let pr: PullRequestRecord | undefined;
    if (dryRun || commitResult.changedPaths.length > 0 || implementer.output.status === "implemented") {
      logger.info(`${runLabel} creating/updating draft PR`);
      pr = await createDraftPr(
        runner,
        profile,
        selectedIssue,
        effectiveRunId,
        worktree.branchName,
        worktree.path,
        runDir,
        logger,
        dryRun,
      );
      if (pr) {
        db.upsertPr(pr);
      }
    } else {
      logger.info(`${runLabel} no PR created (no changes and no implementer output)`);
    }

    db.updateRun(effectiveRunId, {
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
    logger.info(
      `${runLabel} completed successfully for issue #${selectedIssue.number}${
        pr ? ` with PR ${pr.url}` : ""
      }`,
    );

    return {
      runId: effectiveRunId,
      issue: selectedIssue,
      branchName: worktree.branchName,
      worktreePath: worktree.path,
      pr,
      dryRun,
      validationResults,
    };
  } catch (error) {
    db.updateRun(effectiveRunId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    logger.warn(
      `${runLabel} failed for issue #${selectedIssue.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  } finally {
    lockManager.release(selectedIssue.number, owner);
    logger.info(`${runLabel} lock released`);
  }
}

function selectIssue(
  db: StateDatabase,
  profile: RepoProfile,
  requestedIssueNumber?: number,
  issues?: GitHubIssue[],
  edges?: IssueEdge[],
  requireReady = true,
): GitHubIssue {
  if (requestedIssueNumber !== undefined) {
    const requested = db.getIssue(profile.profileName, requestedIssueNumber);
    if (!requested || requested.state !== "OPEN") {
      throw new Error(`Issue #${requestedIssueNumber} is not open in local state`);
    }

    if (!requireReady) {
      return requested;
    }

    const openIssues = issues ?? db.getIssues(profile.profileName, "OPEN");
    const parsedEdges = edges ?? db.getIssueEdges(profile.profileName);
    const activeIssueNumbers = new Set(
      db.getActiveRuns(profile.profileName).map((run) => run.issueNumber),
    );
    const lockedIssueNumbers = new Set(
      db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
    );
    const ready = listReadyIssues(
      profile,
      openIssues,
      parsedEdges,
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
