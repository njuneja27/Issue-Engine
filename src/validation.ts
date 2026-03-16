import { existsSync } from "node:fs";
import { join } from "node:path";

import { minimatch } from "minimatch";

import {
  commandFingerprint,
  commandToString,
  parseCommandInput,
} from "./command-config.js";
import type { CommandRunner } from "./shell.js";
import type { Logger } from "./logging.js";
import type { RepoProfile, ValidationCommand } from "./types.js";

export function selectValidationCommands(
  profile: RepoProfile,
  changedPaths: string[],
): ValidationCommand[] {
  const selected = new Map<string, ValidationCommand>();

  for (const command of profile.validation.base) {
    selected.set(commandFingerprint(command.command), command);
  }

  for (const rule of profile.validation.pathRules ?? []) {
    const matched = changedPaths.some((changedPath) =>
      rule.patterns.some((pattern) => minimatch(changedPath, pattern)),
    );

    if (!matched) {
      continue;
    }

    for (const command of rule.commands) {
      selected.set(commandFingerprint(command.command), command);
    }
  }

  return Array.from(selected.values());
}

export async function runValidationCommands(
  runner: CommandRunner,
  profile: RepoProfile,
  worktreePath: string,
  commands: ValidationCommand[],
  logger: Logger,
  dryRun: boolean,
): Promise<Array<{ name: string; command: string; status: "passed" | "failed" | "skipped" }>> {
  const results: Array<{
    name: string;
    command: string;
    status: "passed" | "failed" | "skipped";
  }> = [];

  const isNodeInstallSkipped =
    process.env.ISSUE_ENGINE_SKIP_NODE_INSTALL?.toLowerCase().trim() === "true";
  const lockfilePath = join(worktreePath, "package-lock.json");
  const markerPath = join(worktreePath, "node_modules", ".package-lock.json");
  const hasLockfile = existsSync(lockfilePath);
  const hasDependencyMarker = existsSync(markerPath);

  if (!dryRun && commands.length > 0) {
    if (isNodeInstallSkipped) {
      logger.info(
        "Dependency bootstrap skipped: ISSUE_ENGINE_SKIP_NODE_INSTALL=true",
      );
    } else if (hasLockfile && !hasDependencyMarker) {
      logger.info(`Running npm ci in ${worktreePath} before validation commands`);
      await runner.run("sh", ["-lc", "npm ci"], { cwd: worktreePath });
    } else if (hasLockfile && hasDependencyMarker) {
      logger.info(
        "Dependency bootstrap skipped: node_modules/.package-lock.json is present",
      );
    } else {
      logger.info(
        "Dependency bootstrap skipped: no package-lock.json at worktree root",
      );
    }
  }

  for (const command of commands) {
    if (dryRun) {
      logger.info(
        `[dry-run] Would run validation command: ${commandToString(command.command)}`,
      );
      const commandString = commandToString(command.command);
      results.push({
        name: command.name,
        command: commandString,
        status: "skipped",
      });
      continue;
    }

    try {
      const parsedCommand = parseCommandInput(command.command);
      await runner.run(parsedCommand.command, parsedCommand.args, { cwd: worktreePath });
      const commandString = commandToString(command.command);
      results.push({
        name: command.name,
        command: commandString,
        status: "passed",
      });
    } catch (error) {
      if (command.optional) {
        logger.warn(
          `Optional validation command failed for ${profile.profileName}: ${commandToString(command.command)}`,
        );
        results.push({
          name: command.name,
          command: commandToString(command.command),
          status: "failed",
        });
        continue;
      }
      throw error;
    }
  }

  return results;
}
