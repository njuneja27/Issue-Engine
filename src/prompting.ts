import { join } from "node:path";

import type { AppConfig } from "./config.js";
import type { GitHubIssue, PlannerOutput, ReconciledPlan, RepoProfile, ReviewerOutput } from "./types.js";
import { interpolateTemplate, readTextFile } from "./utils.js";

export function loadPromptTemplate(appConfig: AppConfig, fileName: string): string {
  return readTextFile(join(appConfig.paths.promptsDir, fileName));
}

export function buildPlannerPrompt(
  appConfig: AppConfig,
  profile: RepoProfile,
  issue: GitHubIssue,
  branchName: string,
  validationSummary: string,
  clarificationContext: string,
): string {
  return interpolateTemplate(loadPromptTemplate(appConfig, "planner.md"), {
    profileName: profile.profileName,
    owner: profile.github.owner,
    repo: profile.github.repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || "(empty)",
    branchName,
    repoPath: profile.localRepoPath,
    worktreeRoot: profile.worktreeRoot,
    defaultBranch: profile.defaultBranch,
    validationPolicy: validationSummary,
    clarificationContext,
  });
}

export function buildReviewerPrompt(
  appConfig: AppConfig,
  profile: RepoProfile,
  issue: GitHubIssue,
  plannerOutput: PlannerOutput,
  validationSummary: string,
): string {
  return interpolateTemplate(loadPromptTemplate(appConfig, "reviewer.md"), {
    profileName: profile.profileName,
    owner: profile.github.owner,
    repo: profile.github.repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || "(empty)",
    plannerJson: JSON.stringify(plannerOutput, null, 2),
    validationPolicy: validationSummary,
  });
}

export function buildImplementerPrompt(
  appConfig: AppConfig,
  profile: RepoProfile,
  issue: GitHubIssue,
  branchName: string,
  plan: ReconciledPlan,
  validationSummary: string,
  clarificationContext: string,
): string {
  return interpolateTemplate(loadPromptTemplate(appConfig, "implementer.md"), {
    profileName: profile.profileName,
    owner: profile.github.owner,
    repo: profile.github.repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || "(empty)",
    branchName,
    repoPath: profile.localRepoPath,
    planJson: JSON.stringify(plan, null, 2),
    validationPolicy: validationSummary,
    clarificationContext,
  });
}

export function renderValidationSummary(profile: RepoProfile): string {
  const lines: string[] = [];
  for (const command of profile.validation.base) {
    lines.push(`- always: ${command.name} -> ${command.command}`);
  }
  for (const rule of profile.validation.pathRules ?? []) {
    for (const command of rule.commands) {
      lines.push(
        `- when changed paths match [${rule.patterns.join(", ")}]: ${command.name} -> ${command.command}`,
      );
    }
  }
  return lines.join("\n");
}
