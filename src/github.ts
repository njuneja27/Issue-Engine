import type { StateDatabase } from "./db.js";
import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";
import type { GitHubIssue, RepoProfile } from "./types.js";

interface GhIssuePayload {
  number: number;
  title: string;
  body?: string | null;
  state: "OPEN" | "CLOSED";
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  author?: { login: string };
  updatedAt: string;
  url: string;
}

export async function syncOpenIssues(
  runner: CommandRunner,
  db: StateDatabase,
  profile: RepoProfile,
  logger: Logger,
): Promise<GitHubIssue[]> {
  logger.info(
    `Syncing open issues from ${profile.github.owner}/${profile.github.repo} for profile ${profile.profileName}`,
  );

  const result = await runner.run("gh", [
    "issue",
    "list",
    "--repo",
    `${profile.github.owner}/${profile.github.repo}`,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,body,state,labels,assignees,author,updatedAt,url",
  ]);

  const payload = JSON.parse(result.stdout) as GhIssuePayload[];
  const issues = payload.map((item) => mapIssue(profile, item));
  db.upsertIssues(profile.profileName, issues);
  logger.info(`Synced ${issues.length} open issues`);
  return issues;
}

function mapIssue(profile: RepoProfile, item: GhIssuePayload): GitHubIssue {
  const labels = (item.labels ?? []).map((label) => label.name);
  const isEpic = labels.some((label) => profile.labels.epic.includes(label));
  const isMeta = (profile.labels.meta ?? []).some((label) => labels.includes(label));
  const priority = labels.reduce((highest, label) => {
    const value = profile.labels.priorityMap[label];
    return value === undefined ? highest : Math.max(highest, value);
  }, 0);

  return {
    profileName: profile.profileName,
    number: item.number,
    title: item.title,
    body: item.body ?? "",
    state: item.state,
    labels,
    assignees: (item.assignees ?? []).map((assignee) => assignee.login),
    author: item.author?.login,
    updatedAt: item.updatedAt,
    url: item.url,
    isEpic,
    isMeta,
    priority,
    raw: item,
  };
}
