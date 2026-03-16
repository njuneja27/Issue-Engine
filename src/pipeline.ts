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
  const owner = options.runOwner ?? `issue-engine:${process.pid}`;

  return runIssue({
    profile,
    appConfig,
    db,
    logger,
    runner,
    codex,
    dryRun,
    runId,
    runOwner: owner,
    issue,
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
  const detailMode = isVerboseMode();
  const phaseNames = [
    "Sync",
    "Graph",
    "Planning",
    "Review",
    "Implementation",
    "Validation",
    "Commit",
    "Create PR",
  ];
  const totalPhases = phaseNames.length;
  const phase = async <T>(index: number, name: string, task: () => Promise<T>): Promise<T> => {
    const label = `Phase ${index}/${totalPhases}: ${name}`;
    const phaseStart = Date.now();
    logger.info(`${runLabel} ${label} start`);
    try {
      const result = await task();
      const elapsed = Date.now() - phaseStart;
      logger.info(`${runLabel} ${label} done (${elapsed}ms)`);
      return result;
    } catch (error) {
      const elapsed = Date.now() - phaseStart;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`${runLabel} ${label} failed (${elapsed}ms): ${message}`);
      throw error;
    }
  };

  if (!dryRun) {
    await enforceCapacityForNewWork(appConfig, runner, logger);
  }

  logger.info(
    `${runLabel} run envelope profile=${profile.profileName} issue=#${issue.number} runId=${effectiveRunId} owner=${owner} mode=${dryRun ? "dry-run" : "real"}`,
  );

  let selectedIssue: GitHubIssue | undefined;
  let lockManager: ReturnType<typeof createLockManager> | undefined;

  try {
    const issues = await phase(1, phaseNames[0], async () => {
      const openIssues = await syncOpenIssues(runner, db, profile, logger);
      if (detailMode) {
        logger.info(`${runLabel} synced ${openIssues.length} open issues`);
      }
      return openIssues;
    });

    const edges = await phase(2, phaseNames[1], async () => {
      const builtEdges = await buildIssueGraph(
        profile,
        issues,
        logger,
        !dryRun && profile.llmDependencyNormalization?.enabled
          ? codex.createDependencyNormalizer()
          : undefined,
      );
      db.replaceIssueEdges(profile.profileName, builtEdges);
      if (detailMode) {
        logger.info(`${runLabel} rebuilt graph with ${builtEdges.length} edge(s)`);
      }
      return builtEdges;
    });

    selectedIssue = selectIssue(db, profile, issue.number, issues, edges, requireIssueReady ?? false);
    if (detailMode) {
      logger.info(`${runLabel} selected issue #${selectedIssue.number}`);
    }

    const runDir = join(appConfig.paths.runLogDir, effectiveRunId);
    ensureDir(runDir);

    lockManager = createLockManager(db, profile.profileName, appConfig.defaultLockLeaseMs);
    if (!lockManager.acquire(selectedIssue.number, owner)) {
      throw new Error(`Issue #${selectedIssue.number} is already locked`);
    }
    if (detailMode) {
      logger.info(`${runLabel} lock acquired for issue #${selectedIssue.number}`);
    }

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

    const validationSummary = renderValidationSummary(profile);

    const planning = await phase(3, phaseNames[2], async () => {
      logger.info(`${runLabel} preparing worktree`);
      const worktree = await prepareWorktree(
        runner,
        db,
        profile,
        selectedIssue!,
        logger,
        dryRun,
      );

      db.updateRun(effectiveRunId, {
        phase: "planning",
        worktreePath: worktree.path,
        metadata: {
          reusedWorktree: worktree.reused,
        },
      });
      if (detailMode) {
        logger.info(`${runLabel} worktree ready at ${worktree.path}`);
      }
      lockManager?.heartbeat(selectedIssue!.number, owner);

      const plannerPrompt = buildPlannerPrompt(
        appConfig,
        profile,
        selectedIssue!,
        worktree.branchName,
        validationSummary,
      );
      const planner = await codex.runPlanner(
        profile,
        plannerPrompt,
        runDir,
        dryRun ? appConfig.paths.rootDir : worktree.path,
        dryRun,
        runLabel,
      );
      db.updateRun(effectiveRunId, {
        phase: "review",
        metadata: {
          plannerModel: planner.modelUsed,
          promptPath: planner.promptPath,
          plannerResponsePath: planner.responsePath,
        },
      });
      lockManager?.heartbeat(selectedIssue!.number, owner);
      return { planner, worktree };
    });

    const planner = planning.planner;
    const worktree = planning.worktree;

    const reviewed = await phase(4, phaseNames[3], async () => {
      const reviewerPrompt = buildReviewerPrompt(
        appConfig,
        profile,
        selectedIssue!,
        planner.output,
        validationSummary,
      );
      const reviewer = await codex.runReviewer(
        profile,
        reviewerPrompt,
        runDir,
        dryRun ? appConfig.paths.rootDir : worktree.path,
        dryRun,
        runLabel,
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
      lockManager?.heartbeat(selectedIssue!.number, owner);
      return { reviewer, reconciledPlan };
    });

    const reviewer = reviewed.reviewer;
    const reconciledPlan = reviewed.reconciledPlan;

    const implementer = await phase(5, phaseNames[4], async () => {
      lockManager?.heartbeat(selectedIssue!.number, owner);
      const implementerPrompt = buildImplementerPrompt(
        appConfig,
        profile,
        selectedIssue!,
        worktree.branchName,
        reconciledPlan,
        validationSummary,
      );
      return codex.runImplementer(
        profile,
        implementerPrompt,
        runDir,
        dryRun ? appConfig.paths.rootDir : worktree.path,
        dryRun,
        runLabel,
      );
    });

    const validation = await phase(6, phaseNames[5], async () => {
      const changedPaths = dryRun
        ? implementer.output.changedFiles
        : await listChangedPaths(runner, worktree.path);
      const validationCommands = selectValidationCommands(profile, changedPaths);
      if (detailMode) {
        logger.info(`${runLabel} running ${validationCommands.length} validation command(s)`);
      }
      const validationResults = await runValidationCommands(
        runner,
        profile,
        worktree.path,
        validationCommands,
        logger,
        dryRun,
      );
      lockManager?.heartbeat(selectedIssue!.number, owner);
      return { changedPaths, validationResults };
    });

    const commitResult = await phase(7, phaseNames[6], async () =>
      commitAndPush(
        runner,
        profile,
        selectedIssue!,
        worktree.path,
        worktree.branchName,
        logger,
        dryRun,
      ),
    );
    lockManager?.heartbeat(selectedIssue.number, owner);

    const pr = await phase(8, phaseNames[7], async () => {
      if (dryRun || commitResult.changedPaths.length > 0 || implementer.output.status === "implemented") {
        const createdPr = await createDraftPr(
          runner,
          profile,
          selectedIssue!,
          effectiveRunId,
          worktree.branchName,
          worktree.path,
          runDir,
          logger,
          dryRun,
        );
        if (createdPr) {
          db.upsertPr(createdPr);
        }
        return createdPr;
      }

      if (detailMode) {
        logger.info(`${runLabel} no PR created (no changes and no implementer output)`);
      }
      return undefined;
    });

    db.updateRun(effectiveRunId, {
      phase: "implementation",
      status: "succeeded",
      endedAt: nowIso(),
      metadata: {
        plannerModel: planner.modelUsed,
        reviewerModel: reviewer.modelUsed,
        implementerModel: implementer.modelUsed,
        changedPaths: validation.changedPaths,
        validationResults: validation.validationResults,
        prUrl: pr?.url,
      },
    });

    logger.info(
      `${runLabel} completed successfully${pr ? ` with PR ${pr.url}` : ""}`,
    );

    return {
      runId: effectiveRunId,
      issue: selectedIssue!,
      branchName: worktree.branchName,
      worktreePath: worktree.path,
      pr,
      dryRun,
      validationResults: validation.validationResults,
    };
  } catch (error) {
    db.updateRun(effectiveRunId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    const errorIssue = selectedIssue ? `issue #${selectedIssue.number}` : `requested issue #${issue.number}`;
    logger.warn(`${runLabel} failed for ${errorIssue}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (lockManager && selectedIssue) {
      lockManager.release(selectedIssue.number, owner);
      logger.info(`${runLabel} lock released`);
    }
  }
}

function isVerboseMode(): boolean {
  return process.env.ISSUE_ENGINE_FEEDBACK_MODE?.trim().toLowerCase() === "verbose";
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
