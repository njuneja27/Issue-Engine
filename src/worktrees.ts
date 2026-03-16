import { existsSync } from "node:fs";
import { join } from "node:path";

import type { StateDatabase } from "./db.js";
import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";
import type { GitHubIssue, RepoProfile, WorktreeRecord } from "./types.js";
import { ensureDir, interpolateTemplate, nowIso, slugify } from "./utils.js";

export interface WorktreePreparation {
  branchName: string;
  path: string;
  reused: boolean;
}

export async function prepareWorktree(
  runner: CommandRunner,
  db: StateDatabase,
  profile: RepoProfile,
  issue: GitHubIssue,
  logger: Logger,
  dryRun: boolean,
): Promise<WorktreePreparation> {
  const slug = slugify(issue.title);
  const branchName = interpolateTemplate(profile.branchNameTemplate, {
    issueNumber: issue.number,
    slug,
    profile: profile.profileName,
  });
  const worktreePath = join(profile.worktreeRoot, `${issue.number}-${slug}`);
  const existing = db.getWorktree(profile.profileName, issue.number);

  if (existing && existsSync(existing.path)) {
    logger.info(`Reusing recorded worktree ${existing.path}`);
    return {
      branchName: existing.branchName,
      path: existing.path,
      reused: true,
    };
  }

  if (existsSync(worktreePath)) {
    logger.info(`Reusing existing worktree path ${worktreePath}`);
    db.upsertWorktree(toRecord(profile.profileName, issue.number, branchName, worktreePath, "ready"));
    return {
      branchName,
      path: worktreePath,
      reused: true,
    };
  }

  ensureDir(profile.worktreeRoot);

  if (!dryRun) {
    await runner.run("git", ["-C", profile.localRepoPath, "fetch", "origin", profile.defaultBranch]);

    const branchCheck = await runner.run(
      "git",
      ["-C", profile.localRepoPath, "show-ref", "--verify", `refs/heads/${branchName}`],
      { allowFailure: true },
    );

    if (branchCheck.exitCode === 0) {
      await runner.run("git", [
        "-C",
        profile.localRepoPath,
        "worktree",
        "add",
        worktreePath,
        branchName,
      ]);
    } else {
      await runner.run("git", [
        "-C",
        profile.localRepoPath,
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        `origin/${profile.defaultBranch}`,
      ]);
    }
  } else {
    logger.info(
      `[dry-run] Would create worktree ${worktreePath} from ${profile.localRepoPath} on ${branchName}`,
    );
  }

  db.upsertWorktree(toRecord(profile.profileName, issue.number, branchName, worktreePath, "ready"));

  return {
    branchName,
    path: worktreePath,
    reused: false,
  };
}

function toRecord(
  profileName: string,
  issueNumber: number,
  branchName: string,
  path: string,
  status: string,
): WorktreeRecord {
  const timestamp = nowIso();
  return {
    profileName,
    issueNumber,
    branchName,
    path,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
