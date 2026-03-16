import { join } from "node:path";

import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";
import type { GitHubIssue, PullRequestRecord, RepoProfile } from "./types.js";
import { interpolateTemplate, nowIso, writeTextFile } from "./utils.js";

export async function listChangedPaths(
  runner: CommandRunner,
  worktreePath: string,
): Promise<string[]> {
  const result = await runner.run(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { allowFailure: false },
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

export async function commitAndPush(
  runner: CommandRunner,
  profile: RepoProfile,
  issue: GitHubIssue,
  worktreePath: string,
  branchName: string,
  logger: Logger,
  dryRun: boolean,
): Promise<{ changedPaths: string[]; commitMessage: string }> {
  const changedPaths = dryRun ? [] : await listChangedPaths(runner, worktreePath);
  const commitMessage = `feat(issue-${issue.number}): ${issue.title}`;

  if (dryRun) {
    logger.info(
      `[dry-run] Would commit and push branch ${branchName} for issue #${issue.number}`,
    );
    return { changedPaths, commitMessage };
  }

  if (changedPaths.length === 0) {
    logger.info(`No working tree changes detected for issue #${issue.number}`);
    return { changedPaths, commitMessage };
  }

  await runner.run("git", ["-C", worktreePath, "add", "-A"]);
  await runner.run("git", ["-C", worktreePath, "commit", "-m", commitMessage]);
  await runner.run("git", ["-C", worktreePath, "push", "--set-upstream", "origin", branchName]);

  return { changedPaths, commitMessage };
}

export async function createDraftPr(
  runner: CommandRunner,
  profile: RepoProfile,
  issue: GitHubIssue,
  runId: string,
  branchName: string,
  worktreePath: string,
  runDir: string,
  logger: Logger,
  dryRun: boolean,
): Promise<PullRequestRecord | undefined> {
  const title = interpolateTemplate(profile.prTemplates.title, {
    issueNumber: issue.number,
    issueTitle: issue.title,
    profile: profile.profileName,
    branchName,
  });
  const body = interpolateTemplate(profile.prTemplates.body, {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url,
    branchName,
    defaultBranch: profile.defaultBranch,
    repoPath: profile.localRepoPath,
  });
  const bodyPath = join(runDir, "pr-body.md");
  writeTextFile(bodyPath, body);

  if (dryRun) {
    logger.info(
      `[dry-run] Would open draft PR against ${profile.github.owner}/${profile.github.repo} from ${branchName}`,
    );
    return {
      profileName: profile.profileName,
      issueNumber: issue.number,
      runId,
      prNumber: 0,
      url: `https://github.com/${profile.github.owner}/${profile.github.repo}/pull/dry-run`,
      branchName,
      status: "DRAFT",
      mergeState: "UNKNOWN",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const result = await runner.run("gh", [
    "pr",
    "create",
    "--repo",
    `${profile.github.owner}/${profile.github.repo}`,
    "--draft",
    "--base",
    profile.defaultBranch,
    "--head",
    branchName,
    "--title",
    title,
    "--body-file",
    bodyPath,
  ], {
    cwd: worktreePath,
  });

  const url = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (!url) {
    throw new Error(`Unable to parse PR URL from gh pr create output: ${result.stdout}`);
  }

  const numberMatch = url.match(/\/pull\/(\d+)$/);
  if (!numberMatch) {
    throw new Error(`Unable to parse PR number from URL: ${url}`);
  }

  return {
    profileName: profile.profileName,
    issueNumber: issue.number,
    runId,
    prNumber: Number(numberMatch[1]),
    url,
    branchName,
    status: "DRAFT",
    mergeState: "UNKNOWN",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}
