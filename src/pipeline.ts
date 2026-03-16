import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { enforceCapacityForNewWork } from "./capacity.js";
import type { StateDatabase } from "./db.js";
import { syncOpenIssues } from "./github.js";
import { buildIssueGraph } from "./issue-graph.js";
import type { Logger } from "./logging.js";
import { createLockManager } from "./locks.js";
import {
  buildImplementerPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  renderValidationSummary,
} from "./prompting.js";
import {
  commitAndPush,
  createPr,
  listChangedPaths,
} from "./prs.js";
import type { CommandRunner } from "./shell.js";
import { listReadyIssues } from "./scheduler.js";
import type { CodexClient } from "./codex.js";
import type {
  ClarificationQuestionAnswer,
  ClarificationQuestionRecord,
  ClarificationQuestionType,
  GitHubIssue,
  PlannerClarificationQuestion,
  PlannerDisposition,
  PlannerOutput,
  RepoProfile,
  RunPhase,
  RunRecord,
} from "./types.js";
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
  onClarificationRequest?: RunIssueOptions["onClarificationRequest"];
  reportProgress?: RunIssueOptions["reportProgress"];
}

export interface RunOnceResult {
  runId: string;
  issue: GitHubIssue;
  branchName: string;
  worktreePath: string;
  pr?: ReturnType<typeof createPr> | undefined;
  dryRun: boolean;
  validationResults: Array<{
    name: string;
    command: string;
    status: "passed" | "failed" | "skipped";
  }>;
  status: "completed" | "blocked";
  clarificationQuestions?: PlannerClarificationQuestion[];
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
  onClarificationRequest?: (options: {
    issue: GitHubIssue;
    runId: string;
    questions: PlannerClarificationQuestion[];
    runLabel: string;
    runDir: string;
    existingAnswers: ClarificationQuestionRecord[];
  }) => Promise<ClarificationQuestionAnswer[]>;
  reportProgress?: (phase: RunPhase, summary: string, prUrl?: string) => void;
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { profile, appConfig, db, logger, runner, codex, dryRun, issueNumber, runOwner } = options;

  const issues = await syncOpenIssues(runner, db, profile, logger);
  const selectedIssue = issueNumber !== undefined
    ? selectSpecificIssue(db, profile, issueNumber, issues, true)
    : selectNextIssue(db, profile, issues);
  const owner = runOwner ?? `issue-engine:${process.pid}`;

  return runIssue({
    profile,
    appConfig,
    db,
    logger,
    runner,
    codex,
    issue: selectedIssue,
    dryRun,
    runOwner: owner,
    onClarificationRequest: options.onClarificationRequest,
    reportProgress: options.reportProgress,
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
    requireIssueReady = false,
    onClarificationRequest,
    reportProgress,
  } = options;

  const owner = runOwner ?? `issue-engine:${process.pid}`;
  const runLabel = `[run ${runId ?? `issue-${issue.number}`}]`;
  const allowBypassApprovalsAndSandbox = profile.codex?.allowBypassApprovalsAndSandbox === true;
  const effectiveRunId = runId ?? randomId(`run-${profile.profileName}-issue-${issue.number}`);
  const detailMode = isVerboseMode();
  const runDir = join(appConfig.paths.runLogDir, effectiveRunId);
  ensureDir(runDir);

  const phase = async <T>(phaseName: RunPhase, task: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      reportProgress?.(phaseName, `${phaseName} start`);
      const value = await task();
      logger.debug(
        `${runLabel} phase=${phaseName} done elapsedMs=${Date.now() - startedAt}`,
      );
      reportProgress?.(phaseName, `${phaseName} done`);
      return value;
    } catch (error) {
      logger.warn(
        `${runLabel} phase=${phaseName} failed elapsedMs=${Date.now() - startedAt}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  };

  const existingRun = runId ? db.getRun(runId) : undefined;
  let selectedIssue = issue;
  let lockAcquired = false;
  let worktreePath = "";
  let branchName = "";
  let plannerDisposition: PlannerDisposition = "ready_to_implement";
  let wasBlocked = false;
  let blockedQuestions: PlannerClarificationQuestion[] = [];
  let currentRun: RunRecord;

  if (!dryRun && !existingRun) {
    await enforceCapacityForNewWork(appConfig, runner, logger);
  }

  if (existingRun) {
    selectedIssue = selectSpecificIssue(db, profile, existingRun.issueNumber, [], false);
    currentRun = {
      ...existingRun,
      status: "running",
      phase: existingRun.phase,
      metadata: {
        ...(existingRun.metadata ?? {}),
        resumedBy: owner,
      },
    };
    db.updateRun(existingRun.runId, currentRun);
  } else {
    currentRun = {
      runId: effectiveRunId,
      profileName: profile.profileName,
      issueNumber: selectedIssue.number,
      phase: "planning",
      status: "running",
      dryRun,
      startedAt: nowIso(),
      metadata: {
        codexBypassApprovalsAndSandbox: allowBypassApprovalsAndSandbox,
        codexBypassApprovalsAndSandboxConfigured: profile.codex !== undefined,
        runOwner: owner,
      },
    };
    db.insertRun(currentRun);
  }

  const run = existingRun ?? currentRun;
  const lockManager = createLockManager(db, profile.profileName, appConfig.defaultLockLeaseMs);
  if (!existingRun) {
    lockAcquired = lockManager.acquire(selectedIssue.number, owner);
    if (!lockAcquired) {
      throw new Error(`Issue #${selectedIssue.number} is already locked`);
    }
  } else {
    // Keep any pre-existing lock if this is a resumed blocked run.
    lockManager.heartbeat(selectedIssue.number, owner);
  }

  logger.info(
    `${runLabel} run envelope profile=${profile.profileName} issue=#${selectedIssue.number} runId=${run.runId} owner=${owner} mode=${dryRun ? "dry-run" : "real"}`,
  );

  const preparePhase = async (): Promise<void> => {
    const worktree = await phase("planning", async () =>
      prepareWorktree(
        runner,
        db,
        profile,
        selectedIssue,
        logger,
        dryRun,
      ),
    );
    worktreePath = worktree.path;
    branchName = worktree.branchName;
    db.updateRun(run.runId, {
      phase: "planning",
      worktreePath,
      metadata: {
        ...(run.metadata ?? {}),
        reusedWorktree: worktree.reused,
      },
    });
  };

  const runWithHeartbeat = async <T>(task: () => Promise<T>): Promise<T> => {
    lockManager.heartbeat(selectedIssue.number, owner);
    return task();
  };

  try {
    if (!existingRun || existingRun.status !== "blocked") {
      const edges = await phase("reconciliation", async () => {
        const openIssues = await syncOpenIssues(runner, db, profile, logger);
        const selectedOpenIssues = issueSelectionIssues(openIssues);
        const graph = await buildIssueGraph(
          profile,
          selectedOpenIssues,
          logger,
          !dryRun && profile.llmDependencyNormalization?.enabled
            ? codex.createDependencyNormalizer()
            : undefined,
        );
        db.replaceIssueEdges(profile.profileName, graph);
        return graph;
      });

      if (requireIssueReady && existingRun?.status !== "blocked") {
        const activeIssueNumbers = new Set(
          db.getActiveRuns(profile.profileName).map((run) => run.issueNumber),
        );
        const lockedIssueNumbers = new Set(
          db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
        );
        const ready = listReadyIssues(
          profile,
          db.getIssues(profile.profileName, "OPEN"),
          edges,
          activeIssueNumbers,
          lockedIssueNumbers,
        );
        if (!ready.some((item) => item.issue.number === selectedIssue.number)) {
          throw new Error(`Issue #${selectedIssue.number} is not currently ready to run`);
        }
      }
    }

    await preparePhase();

    const clarificationSummary = db.getAnsweredClarificationSummary(run.runId);
    const validationSummary = renderValidationSummary(profile);

    let planner: { output: PlannerOutput; modelUsed: string; responsePath: string };
    const previousPlanner = extractPlannerFromMetadata(run.metadata);

    if (existingRun?.status === "blocked" && previousPlanner) {
      planner = { output: previousPlanner, modelUsed: "resume", responsePath: "" };
    } else {
      const plannerPrompt = buildPlannerPrompt(
        appConfig,
        profile,
        selectedIssue,
        branchName,
        validationSummary,
        clarificationSummary,
      );
        planner = await phase("planning", () =>
        runWithHeartbeat(() =>
          codex.runPlanner(
            profile,
            plannerPrompt,
            runDir,
            dryRun ? appConfig.paths.rootDir : worktreePath,
            dryRun,
            runLabel,
          ),
        ),
      );
    }

    db.updateRun(run.runId, {
      phase: "review",
      metadata: {
        ...(run.metadata ?? {}),
        plannerModel: planner.modelUsed,
        plannerResponsePath: planner.responsePath,
        plannerSummary: planner.output.summary,
        plannerDisposition: planner.output.disposition,
        plannerOutput: planner.output,
      },
    });
    plannerDisposition = planner.output.disposition;

    if (planner.output.disposition === "needs_clarification") {
      db.upsertClarificationQuestions(
        run.runId,
        selectedIssue.number,
        "clarification",
        (planner.output.clarificationQuestions ?? []).map((question) => ({
          questionId: question.questionId,
          questionType: question.questionType,
          question: question.question,
          options: question.options,
        })),
      );

      blockedQuestions = db
        .listClarificationQuestions(run.runId, "pending")
        .map((question) => ({
          questionId: question.questionKey,
          questionType: question.questionType,
          question: question.prompt,
          options: question.options,
        }));

      if (blockedQuestions.length > 0) {
        if (!onClarificationRequest) {
          wasBlocked = true;
          db.updateRun(run.runId, {
            phase: "clarification",
            status: "blocked",
            metadata: {
              ...(run.metadata ?? {}),
              plannerDisposition,
              blockedAt: nowIso(),
            },
          });
          return {
            runId: run.runId,
            issue: selectedIssue,
            branchName,
            worktreePath,
            dryRun,
            validationResults: [],
            status: "blocked",
            clarificationQuestions: blockedQuestions,
          };
        }

        const existingAnswers = db.getClarificationQuestions(run.runId);
        await requestClarificationAnswers({
          db,
          runId: run.runId,
          issue: selectedIssue,
          questions: blockedQuestions,
          existingAnswers,
          onClarificationRequest,
          runLabel,
          runDir: join(appConfig.paths.runLogDir, run.runId),
        });
      }
      db.updateRun(run.runId, {
        phase: "implementation",
        metadata: {
          ...(run.metadata ?? {}),
          clarificationAnsweredAt: nowIso(),
        },
      });
      plannerDisposition = "ready_to_implement";
    } else if (planner.output.disposition === "blocked") {
      db.updateRun(run.runId, {
        status: "succeeded",
        phase: "implementation",
        endedAt: nowIso(),
        metadata: {
          ...(run.metadata ?? {}),
          plannerDisposition,
          blockedByPlanner: true,
          plannerSummary: planner.output.summary,
        },
      });

      return {
        runId: run.runId,
        issue: selectedIssue,
        branchName,
        worktreePath,
        dryRun,
        validationResults: [],
        status: "completed",
      };
    }

    const reviewResult = await phase("review", () =>
      runWithHeartbeat(async () => {
        const reviewerPrompt = buildReviewerPrompt(
          appConfig,
          profile,
          selectedIssue,
          planner.output,
          validationSummary,
        );
        return codex.runReviewer(
          profile,
          reviewerPrompt,
          runDir,
          dryRun ? appConfig.paths.rootDir : worktreePath,
          dryRun,
          runLabel,
        );
      }),
    );
    const reconciledPlan = codex.reconcilePlan(planner.output, reviewResult.output);
    db.updateRun(run.runId, {
      phase: "implementation",
      metadata: {
        ...(run.metadata ?? {}),
        reviewerModel: reviewResult.modelUsed,
        reviewerResponsePath: reviewResult.responsePath,
      },
    });

    const implementer = await phase("implementation", () =>
      runWithHeartbeat(async () =>
        codex.runImplementer(
          profile,
          buildImplementerPrompt(
            appConfig,
            profile,
            selectedIssue,
            branchName,
            reconciledPlan,
            validationSummary,
            db.getAnsweredClarificationSummary(run.runId),
          ),
          runDir,
          dryRun ? appConfig.paths.rootDir : worktreePath,
          dryRun,
          runLabel,
        ),
      ),
    );

    const validation = await phase("validation", () =>
      runWithHeartbeat(async () => {
        const changedPaths = dryRun
          ? implementer.output.changedFiles
          : await listChangedPaths(runner, worktreePath);
        const commands = selectValidationCommands(profile, changedPaths);
        if (detailMode) {
          logger.info(`${runLabel} running ${commands.length} validation command(s)`);
        }
        return {
          changedPaths,
          validationResults: await runValidationCommands(
            runner,
            profile,
            worktreePath,
            commands,
            logger,
            dryRun,
          ),
          followUps: implementer.output.followUps,
        };
      }),
    );

    const commitResult = await phase("commit", () =>
      runWithHeartbeat(async () =>
        commitAndPush(
          runner,
          profile,
          selectedIssue,
          worktreePath,
          branchName,
          logger,
          dryRun,
        ),
      ),
    );
    void commitResult;

    const shouldCreatePr = !dryRun && implementer.output.status === "implemented";
    const pr = await phase("create_pr", () =>
      runWithHeartbeat(async () => {
        if (!shouldCreatePr || implementer.output.changedFiles.length === 0) {
          if (detailMode) {
            logger.info(`${runLabel} no PR created (no implementer changes)`);
          }
          return undefined;
        }

        const createdPr = await createPr(
          runner,
          profile,
          selectedIssue,
          run.runId,
          branchName,
          worktreePath,
          join(appConfig.paths.runLogDir, run.runId),
          logger,
          dryRun,
        );
        if (!createdPr) {
          return undefined;
        }
        db.upsertPr(createdPr);
        reportProgress?.("create_pr", "Created non-draft PR", createdPr.url);
        return createdPr;
      }),
    );

    db.updateRun(run.runId, {
      phase: "create_pr",
      status: "succeeded",
      endedAt: nowIso(),
      metadata: {
        ...(run.metadata ?? {}),
        plannerDisposition,
        prUrl: pr?.url,
        changedPaths: validation.changedPaths,
        validationResults: validation.validationResults,
        followUps: validation.followUps,
        reconciliationSummary: reconciledPlan.summary,
        implementationSummary: implementer.output.summary,
      },
    });

    return {
      runId: run.runId,
      issue: selectedIssue,
      branchName,
      worktreePath,
      pr,
      dryRun,
      validationResults: validation.validationResults,
      status: "completed",
    };
  } catch (error) {
    db.updateRun(run.runId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        ...(run.metadata ?? {}),
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
    if (lockAcquired) {
      lockManager.release(selectedIssue.number, owner);
    }
    if (!worktreePath) {
      return;
    }
    lockManager.heartbeat(selectedIssue.number, owner);
  }
}

async function requestClarificationAnswers(input: {
  db: StateDatabase;
  runId: string;
  issue: GitHubIssue;
  questions: PlannerClarificationQuestion[];
  existingAnswers: ClarificationQuestionRecord[];
  onClarificationRequest: NonNullable<RunIssueOptions["onClarificationRequest"]>;
  runLabel: string;
  runDir: string;
}): Promise<void> {
  const answerPayload = await input.onClarificationRequest({
    issue: input.issue,
    runId: input.runId,
    questions: input.questions,
    existingAnswers: input.existingAnswers,
    runLabel: input.runLabel,
    runDir: input.runDir,
  });

  for (const question of input.questions) {
    const answer = answerPayload.find((item) => item.questionId === question.questionId);
    if (!answer) {
      continue;
    }
    input.db.setClarificationAnswer(
      input.runId,
      question.questionId,
      normalizeAnswerText(answer.answer),
      normalizeSelectedOption(question.questionType, answer),
    );
  }
  const unanswered = input.questions.filter(
    (question) =>
      !answerPayload.some((answer) => answer.questionId === question.questionId),
  );
  if (unanswered.length > 0) {
    throw new Error(`Missing answers for clarification questions: ${unanswered.map((question) => question.questionId).join(", ")}`);
  }
}

function normalizeAnswerText(raw: string): string {
  return raw.trim();
}

function normalizeSelectedOption(
  questionType: ClarificationQuestionType,
  answer: ClarificationQuestionAnswer,
): number | null {
  if (questionType !== "multiple_choice") {
    return null;
  }

  return answer.selectedOption;
}

function issueSelectionIssues(issues: GitHubIssue[]): GitHubIssue[] {
  return issues.filter((issue) => issue.state === "OPEN");
}

function selectSpecificIssue(
  db: StateDatabase,
  profile: RepoProfile,
  issueNumber: number,
  issues: GitHubIssue[],
  requireReady: boolean,
): GitHubIssue {
  const issue = issues.find((item) => item.number === issueNumber)
    ?? db.getIssue(profile.profileName, issueNumber);
  if (!issue || issue.state !== "OPEN") {
    throw new Error(`Issue #${issueNumber} is not open in local state`);
  }

  if (!requireReady) {
    return issue;
  }

  const openIssues = db.getIssues(profile.profileName, "OPEN");
  const edges = db.getIssueEdges(profile.profileName);
  const activeIssueNumbers = new Set(
    db.getActiveRuns(profile.profileName).map((run) => run.issueNumber),
  );
  const lockedIssueNumbers = new Set(
    db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
  );
  const ready = listReadyIssues(
    profile,
    openIssues,
    edges,
    activeIssueNumbers,
    lockedIssueNumbers,
  );
  const candidate = ready.find((item) => item.issue.number === issueNumber);
  if (!candidate) {
    throw new Error(`Issue #${issueNumber} is not currently ready to run`);
  }
  return issue;
}

function selectNextIssue(
  db: StateDatabase,
  profile: RepoProfile,
  issues: GitHubIssue[],
): GitHubIssue {
  const edges = db.getIssueEdges(profile.profileName);
  const openIssueNumbers = new Set(
    issues.filter((issue) => issue.state === "OPEN").map((issue) => issue.number),
  );
  const activeIssueNumbers = new Set(
    db.getActiveRuns(profile.profileName).map((run) => run.issueNumber),
  );
  const lockedIssueNumbers = new Set(
    db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
  );
  const ready = listReadyIssues(
    profile,
    issues.filter((issue) => issue.state === "OPEN"),
    edges,
    activeIssueNumbers,
    lockedIssueNumbers,
  ).filter((candidate) => openIssueNumbers.has(candidate.issue.number));
  if (ready.length === 0) {
    throw new Error(`No ready issue found for profile ${profile.profileName}`);
  }
  return ready[0].issue;
}

function isVerboseMode(): boolean {
  return process.env.ISSUE_ENGINE_FEEDBACK_MODE?.trim().toLowerCase() === "verbose";
}

function extractPlannerFromMetadata(metadata: Record<string, unknown> | undefined): PlannerOutput | undefined {
  const candidate = metadata?.plannerOutput;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  return candidate as PlannerOutput;
}
