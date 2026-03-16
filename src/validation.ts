import { minimatch } from "minimatch";

import type { CommandRunner } from "./shell.js";
import type { Logger } from "./logging.js";
import type { RepoProfile, ValidationCommand } from "./types.js";

export function selectValidationCommands(
  profile: RepoProfile,
  changedPaths: string[],
): ValidationCommand[] {
  const selected = new Map<string, ValidationCommand>();

  for (const command of profile.validation.base) {
    selected.set(command.command, command);
  }

  for (const rule of profile.validation.pathRules ?? []) {
    const matched = changedPaths.some((changedPath) =>
      rule.patterns.some((pattern) => minimatch(changedPath, pattern)),
    );

    if (!matched) {
      continue;
    }

    for (const command of rule.commands) {
      selected.set(command.command, command);
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

  for (const command of commands) {
    if (dryRun) {
      logger.info(`[dry-run] Would run validation command: ${command.command}`);
      results.push({
        name: command.name,
        command: command.command,
        status: "skipped",
      });
      continue;
    }

    try {
      await runner.run("sh", ["-lc", command.command], { cwd: worktreePath });
      results.push({
        name: command.name,
        command: command.command,
        status: "passed",
      });
    } catch (error) {
      if (command.optional) {
        logger.warn(
          `Optional validation command failed for ${profile.profileName}: ${command.command}`,
        );
        results.push({
          name: command.name,
          command: command.command,
          status: "failed",
        });
        continue;
      }
      throw error;
    }
  }

  return results;
}
