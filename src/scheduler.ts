import type { StateDatabase } from "./db.js";
import { buildBlockerMap, buildChildMap } from "./issue-graph.js";
import type { GitHubIssue, IssueEdge, RepoProfile, SchedulerCandidate } from "./types.js";

export interface SchedulerOptions {
  ignoreConcurrency?: boolean;
}

export function listReadyIssues(
  profile: RepoProfile,
  issues: GitHubIssue[],
  edges: IssueEdge[],
  activeIssueNumbers: Set<number>,
  lockedIssueNumbers: Set<number>,
): SchedulerCandidate[] {
  const blockers = buildBlockerMap(edges);
  const children = buildChildMap(edges);
  const openIssueNumbers = new Set(
    issues.filter((issue) => issue.state === "OPEN").map((issue) => issue.number),
  );

  return issues
    .filter((issue) => issue.state === "OPEN")
    .filter((issue) => !profile.labels.skip.some((label) => issue.labels.includes(label)))
    .filter((issue) => profile.allowMetaIssues || !issue.isMeta)
    .filter((issue) => !activeIssueNumbers.has(issue.number))
    .filter((issue) => !lockedIssueNumbers.has(issue.number))
    .map((issue) => {
      const blockedBy = (blockers.get(issue.number) ?? []).filter((dependency) =>
        openIssueNumbers.has(dependency),
      );

      const leafBoost = (children.get(issue.number) ?? []).length === 0 ? 1000 : 0;
      const epicPenalty = issue.isEpic ? -500 : 0;
      const metaPenalty = issue.isMeta ? -250 : 0;
      const priorityScore = issue.priority * 100;
      const ageBias = -issue.number;

      return {
        issue,
        blockedBy,
        score: priorityScore + leafBoost + epicPenalty + metaPenalty + ageBias,
        reason: blockedBy.length > 0 ? `blocked by ${blockedBy.join(", ")}` : undefined,
      };
    })
    .filter((candidate) => candidate.blockedBy.length === 0)
    .sort((left, right) => right.score - left.score);
}

export function nextReadyIssue(
  db: StateDatabase,
  profile: RepoProfile,
  options: SchedulerOptions = {},
): SchedulerCandidate | undefined {
  const activeRuns = db.getActiveRuns(profile.profileName);
  if (!options.ignoreConcurrency && activeRuns.length >= profile.concurrency) {
    return undefined;
  }

  const issues = db.getIssues(profile.profileName, "OPEN");
  const edges = db.getIssueEdges(profile.profileName);
  const activeIssueNumbers = new Set(activeRuns.map((run) => run.issueNumber));
  const lockedIssueNumbers = new Set(
    db.getActiveLocks(profile.profileName).map((lock) => lock.issueNumber),
  );

  return listReadyIssues(
    profile,
    issues,
    edges,
    activeIssueNumbers,
    lockedIssueNumbers,
  )[0];
}
