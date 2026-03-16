import type { AppConfig } from "./config.js";
import type { StateDatabase } from "./db.js";
import type { Logger } from "./logging.js";
import { runIssue, runOnce, type RunIssueOptions } from "./pipeline.js";
import type { CommandRunner } from "./shell.js";
import type { CodexClient } from "./codex.js";
import type { RepoProfile, RunRecord } from "./types.js";
import { nowIso } from "./utils.js";

const defaultNoWorkDelayMs = 5000;
const defaultRetryBackoffMs = 1250;

type IterationResult = { didWork: boolean; waitMs: number };

export interface RunWorkerOptions {
  profile: RepoProfile;
  appConfig: AppConfig;
  db: StateDatabase;
  logger: Logger;
  runner: CommandRunner;
  codex: CodexClient;
  intervalMs: number;
  parallel: number;
  maxRuns?: number | undefined;
  issueNumber?: number | undefined;
  dryRun: boolean;
  stopSignal?: AbortSignal | undefined;
}

export async function runWorkerLoop(options: RunWorkerOptions): Promise<void> {
  const stopController = new AbortController();
  const signal = stopController.signal;

  if (options.stopSignal) {
    if (options.stopSignal.aborted) {
      stopController.abort();
    } else {
      options.stopSignal.addEventListener(
        "abort",
        () => {
          stopController.abort();
        },
        { once: true },
      );
    }
  }

  const state = {
    completedRuns: 0,
  };
  const workerCount = Math.max(1, options.parallel);
  const workers = Array.from({ length: workerCount }, (_, index) =>
    runWorker(index + 1, options, signal, state, stopController),
  );

  await Promise.all(workers);
}

async function runWorker(
  workerId: number,
  options: RunWorkerOptions,
  signal: AbortSignal,
  state: { completedRuns: number },
  stopController: AbortController,
): Promise<void> {
  while (!signal.aborted) {
    const iteration = await runWorkerIteration(workerId, options, signal);
    const shouldStop = await handleIterationResult({
      options,
      signal,
      iteration,
      state,
      stopController,
    });
    if (shouldStop) {
      return;
    }
    await sleepWithSignal(iteration.waitMs, signal);
  }
}

async function runWorkerIteration(
  workerId: number,
  options: RunWorkerOptions,
  signal: AbortSignal,
): Promise<IterationResult> {
  if (signal.aborted) {
    return { didWork: false, waitMs: 0 };
  }

  const running = options.db.getRunningRuns(options.profile.profileName);
  if (running.length >= options.profile.concurrency) {
    options.logger.debug(`Worker ${workerId} at capacity for ${options.profile.profileName}`);
    return { didWork: false, waitMs: options.intervalMs };
  }

  const queuedRepair = options.db.claimQueuedRun(options.profile.profileName, {
    phase: "repair",
    issueNumber: options.issueNumber,
  });
  if (queuedRepair) {
    options.logger.info(
      `Worker ${workerId} picked queued repair run ${queuedRepair.runId} (phase=${queuedRepair.phase}) for issue #${queuedRepair.issueNumber}`,
    );
    return runQueuedWorkWithRetry(workerId, options, queuedRepair, signal);
  }

  if (options.issueNumber !== undefined) {
    const queuedForIssue = options.db.claimQueuedRun(options.profile.profileName, {
      issueNumber: options.issueNumber,
    });
    if (queuedForIssue) {
      options.logger.info(
        `Worker ${workerId} picked queued run ${queuedForIssue.runId} (phase=${queuedForIssue.phase}) for issue #${queuedForIssue.issueNumber}`,
      );
      return runQueuedWorkWithRetry(workerId, options, queuedForIssue, signal);
    }
  } else {
    const queuedRun = options.db.claimQueuedRun(options.profile.profileName);
    if (queuedRun) {
      options.logger.info(
        `Worker ${workerId} picked queued run ${queuedRun.runId} (phase=${queuedRun.phase}) for issue #${queuedRun.issueNumber}`,
      );
      return runQueuedWorkWithRetry(workerId, options, queuedRun, signal);
    }
  }

  if (options.issueNumber !== undefined) {
    return runSpecificIssue(workerId, options);
  }

  return runNextReadyIssue(workerId, options);
}

async function runSpecificIssue(
  workerId: number,
  options: RunWorkerOptions,
): Promise<IterationResult> {
  const owner = `worker-${workerId}:${process.pid}`;
  try {
    const result = await runOnce({
      profile: options.profile,
      appConfig: options.appConfig,
      db: options.db,
      logger: options.logger,
      runner: options.runner,
      codex: options.codex,
      issueNumber: options.issueNumber,
      dryRun: options.dryRun,
      runOwner: owner,
    });
    options.logger.info(
      `Worker ${workerId} started run ${result.runId} (phase=planning) for issue #${result.issue.number}`,
    );
    return { didWork: true, waitMs: 0 };
  } catch (error) {
    const waitMs = classifyRetryDelayMs(error, options.intervalMs);
    if (waitMs !== undefined) {
      options.logger.debug(`Worker ${workerId} issue #${options.issueNumber} not ready: ${errorMessage(error)}`);
      return { didWork: false, waitMs };
    }

    options.logger.warn(
      `Worker ${workerId} run failed for issue #${options.issueNumber} (phase=planning): ${errorMessage(error)}`,
    );
    return { didWork: true, waitMs: defaultNoWorkDelayMs };
  }
}

async function runNextReadyIssue(workerId: number, options: RunWorkerOptions): Promise<IterationResult> {
  const owner = `worker-${workerId}:${process.pid}`;
  try {
    const result = await runOnce({
      profile: options.profile,
      appConfig: options.appConfig,
      db: options.db,
      logger: options.logger,
      runner: options.runner,
      codex: options.codex,
      dryRun: options.dryRun,
      runOwner: owner,
    });
    options.logger.info(
      `Worker ${workerId} started run ${result.runId} (phase=planning) for issue #${result.issue.number}`,
    );
    return { didWork: true, waitMs: 0 };
  } catch (error) {
    const waitMs = classifyRetryDelayMs(error, options.intervalMs);
    if (waitMs !== undefined) {
      options.logger.debug(`Worker ${workerId} no ready issue yet: ${errorMessage(error)}`);
      return { didWork: false, waitMs };
    }

    options.logger.warn(`Worker ${workerId} run failed (phase=planning): ${errorMessage(error)}`);
    return { didWork: true, waitMs: defaultNoWorkDelayMs };
  }
}

async function runQueuedWorkWithRetry(
  workerId: number,
  options: RunWorkerOptions,
  queuedRun: RunRecord,
  signal: AbortSignal,
): Promise<IterationResult> {
  try {
    options.logger.info(
      `Worker ${workerId} queue-handler starting run ${queuedRun.runId} (phase=${queuedRun.phase}) for issue #${queuedRun.issueNumber}`,
    );
    await executeQueuedRun({
      workerId,
      options,
      queuedRun,
      signal,
    });
    return { didWork: true, waitMs: 0 };
  } catch (error) {
    const waitMs = classifyRetryDelayMs(error, options.intervalMs);
    if (waitMs !== undefined) {
      options.logger.debug(
        `Worker ${workerId} retrying queued run ${queuedRun.runId}: ${errorMessage(error)}`,
      );
      return { didWork: false, waitMs };
    }

    options.logger.warn(
      `Worker ${workerId} failed queued run ${queuedRun.runId} (phase=${queuedRun.phase}): ${errorMessage(error)}`,
    );
    return { didWork: true, waitMs: defaultNoWorkDelayMs };
  }
}

async function executeQueuedRun(context: {
  workerId: number;
  options: RunWorkerOptions;
  queuedRun: RunRecord;
  signal: AbortSignal;
}): Promise<void> {
  const issue = context.options.db.getIssue(context.options.profile.profileName, context.queuedRun.issueNumber);
  if (context.signal.aborted) {
    context.options.logger.debug(
      `Worker ${context.workerId} queued run ${context.queuedRun.runId} aborted before start`,
    );
    context.options.db.updateRun(context.queuedRun.runId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        error: "Execution aborted before queued run started",
      },
    });
    return;
  }

  context.options.logger.info(
    `Worker ${context.workerId}: starting queued run ${context.queuedRun.runId} (phase=${context.queuedRun.phase}) for issue #${context.queuedRun.issueNumber}`,
  );

  if (!issue || issue.state !== "OPEN") {
    context.options.db.updateRun(context.queuedRun.runId, {
      status: "failed",
      endedAt: nowIso(),
      metadata: {
        error: `Issue #${context.queuedRun.issueNumber} is not open in local state`,
      },
    });
    context.options.logger.warn(
      `Worker ${context.workerId}: queued run ${context.queuedRun.runId} failed (phase=${context.queuedRun.phase}); issue #${context.queuedRun.issueNumber} unavailable`,
    );
    return;
  }

  const runIssueOptions: RunIssueOptions = {
    profile: context.options.profile,
    appConfig: context.options.appConfig,
    db: context.options.db,
    logger: context.options.logger,
    runner: context.options.runner,
    codex: context.options.codex,
    issue,
    runId: context.queuedRun.runId,
    runOwner: `worker-${context.workerId}:${process.pid}`,
    dryRun: context.options.dryRun,
    requireIssueReady: false,
  };

  await runIssue(runIssueOptions);
}

async function handleIterationResult(params: {
  options: RunWorkerOptions;
  signal: AbortSignal;
  iteration: IterationResult;
  state: { completedRuns: number };
  stopController: AbortController;
}): Promise<boolean> {
  const { options, state, stopController, iteration } = params;

  if (iteration.didWork) {
    state.completedRuns += 1;
  }

  if (options.maxRuns !== undefined && state.completedRuns >= options.maxRuns) {
    stopController.abort();
    return true;
  }

  if (params.signal.aborted) {
    return true;
  }

  return false;
}

function classifyRetryDelayMs(error: unknown, intervalMs: number): number | undefined {
  const message = errorMessage(error);

  if (/already locked|Capacity gate blocked new work|Capacity check failed/i.test(message)) {
    return backoffDelayMs(defaultRetryBackoffMs);
  }

  if (/No ready issue found|not currently ready to run|is not open in local state/i.test(message)) {
    return intervalMs;
  }

  return undefined;
}

function backoffDelayMs(baseDelayMs: number): number {
  return baseDelayMs + Math.floor(Math.random() * 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
