import type { AppConfig } from "./config.js";
import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";

export interface CapacityStatus {
  enabled: boolean;
  sourceCommand?: string | undefined;
  rawOutput?: string | undefined;
  remainingPercent?: number | undefined;
  usedPercent?: number | undefined;
  thresholdPercent?: number | undefined;
  shouldBlockNewWork: boolean;
  available: boolean;
  windowLabel?: string | undefined;
  reason: string;
}

const defaultRemainingPatterns = [
  String.raw`(?<remaining>\d+(?:\.\d+)?)%\s*(?:remaining|left)`,
  String.raw`(?:remaining|left)\s*:?\s*(?<remaining>\d+(?:\.\d+)?)%`,
];

const defaultUsedPatterns = [
  String.raw`(?<used>\d+(?:\.\d+)?)%\s*used`,
  String.raw`used\s*:?\s*(?<used>\d+(?:\.\d+)?)%`,
];

export async function getCapacityStatus(
  appConfig: AppConfig,
  runner: CommandRunner,
): Promise<CapacityStatus> {
  const config = appConfig.capacityCheck;
  if (!config || !config.enabled) {
    return {
      enabled: false,
      shouldBlockNewWork: false,
      available: false,
      reason: "Capacity gate disabled",
    };
  }

  const result = await runner.run("sh", ["-lc", config.command], {
    cwd: config.cwd ?? appConfig.paths.rootDir,
    allowFailure: true,
  });
  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    if (config.failOpen ?? true) {
      return {
        enabled: true,
        sourceCommand: config.command,
        rawOutput: output,
        thresholdPercent: config.minRemainingPercent,
        shouldBlockNewWork: false,
        available: false,
        windowLabel: config.windowLabel,
        reason: `Capacity command failed with exit code ${result.exitCode}; fail-open allowed`,
      };
    }

    throw new Error(
      `Capacity command failed with exit code ${result.exitCode}: ${output || config.command}`,
    );
  }

  const parsed = parseCapacityOutput(
    output,
    config.remainingPercentPatterns,
    config.usedPercentPatterns,
    config.windowLabel,
  );
  if (!parsed) {
    if (config.failOpen ?? true) {
      return {
        enabled: true,
        sourceCommand: config.command,
        rawOutput: output,
        thresholdPercent: config.minRemainingPercent,
        shouldBlockNewWork: false,
        available: false,
        windowLabel: config.windowLabel,
        reason: "Could not parse remaining capacity from command output; fail-open allowed",
      };
    }

    throw new Error(
      `Could not parse remaining capacity from command output. Command: ${config.command}`,
    );
  }

  const shouldBlockNewWork =
    (config.blockNewWork ?? true) &&
    parsed.remainingPercent < config.minRemainingPercent;

  return {
    enabled: true,
    sourceCommand: config.command,
    rawOutput: output,
    remainingPercent: parsed.remainingPercent,
    usedPercent: parsed.usedPercent,
    thresholdPercent: config.minRemainingPercent,
    shouldBlockNewWork,
    available: true,
    windowLabel: config.windowLabel ?? "7d",
    reason: shouldBlockNewWork
      ? `${parsed.remainingPercent}% remaining is below the ${config.minRemainingPercent}% threshold`
      : `${parsed.remainingPercent}% remaining is above the ${config.minRemainingPercent}% threshold`,
  };
}

export async function enforceCapacityForNewWork(
  appConfig: AppConfig,
  runner: CommandRunner,
  logger: Logger,
): Promise<void> {
  const status = await getCapacityStatus(appConfig, runner);
  if (!status.enabled) {
    return;
  }

  if (!status.available) {
    logger.warn(status.reason);
    return;
  }

  logger.info(
    `Capacity check (${status.windowLabel ?? "7d"}): ${status.remainingPercent}% remaining`,
  );
  if (status.shouldBlockNewWork) {
    throw new Error(
      `Capacity gate blocked new work: ${status.remainingPercent}% remaining is below ${status.thresholdPercent}%`,
    );
  }
}

export function parseCapacityOutput(
  output: string,
  remainingPatterns?: string[] | undefined,
  usedPatterns?: string[] | undefined,
  preferredWindowLabel?: string | undefined,
): { remainingPercent: number; usedPercent?: number | undefined } | undefined {
  const scopedOutput = preferredWindowLabel
    ? extractWindowSection(output, preferredWindowLabel) ?? output
    : output;

  const remaining = findPercent(
    scopedOutput,
    remainingPatterns ?? defaultRemainingPatterns,
    "remaining",
  );
  if (remaining !== undefined) {
    return {
      remainingPercent: remaining,
      usedPercent: scopedOutput
        ? findPercent(scopedOutput, usedPatterns ?? defaultUsedPatterns, "used")
        : undefined,
    };
  }

  const used = findPercent(scopedOutput, usedPatterns ?? defaultUsedPatterns, "used");
  if (used !== undefined) {
    return {
      remainingPercent: Number((100 - used).toFixed(2)),
      usedPercent: used,
    };
  }

  return undefined;
}

function extractWindowSection(output: string, windowLabel: string): string | undefined {
  const escaped = escapeRegExp(windowLabel);
  const headerPattern = new RegExp(`^\\s*${escaped}\\s+limit:\\s*$`, "im");
  const headerMatch = headerPattern.exec(output);
  if (!headerMatch || headerMatch.index === undefined) {
    return undefined;
  }

  const start = headerMatch.index + headerMatch[0].length;
  const remainder = output.slice(start);
  const nextHeaderMatch = /^\s*[A-Za-z0-9][^\n]*limit:\s*$/im.exec(remainder);
  return nextHeaderMatch
    ? remainder.slice(0, nextHeaderMatch.index).trim()
    : remainder.trim();
}

function findPercent(
  output: string,
  patterns: string[],
  groupName: "remaining" | "used",
): number | undefined {
  for (const pattern of patterns) {
    const match = output.match(new RegExp(pattern, "i"));
    if (!match) {
      continue;
    }

    const named = match.groups?.[groupName];
    const fallback = match[1];
    const raw = named ?? fallback;
    if (!raw) {
      continue;
    }

    const value = Number(raw);
    if (!Number.isNaN(value)) {
      return value;
    }
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
