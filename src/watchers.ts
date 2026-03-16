import type { StateDatabase } from "./db.js";
import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";
import type { RepoProfile, RunRecord } from "./types.js";
import { nowIso, randomId } from "./utils.js";

interface PrWatchPayload {
  data?: {
    repository?: {
      pullRequest?: {
        number: number;
        url: string;
        mergeStateStatus: string;
        isDraft: boolean;
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            comments: {
              nodes: Array<{
                id: string;
                body: string;
                createdAt: string;
                updatedAt: string;
                author?: { login: string };
              }>;
            };
          }>;
        };
        reviews: {
          nodes: Array<{
            id: string;
            state: string;
            body: string;
            submittedAt: string;
            author?: { login: string };
          }>;
        };
      };
    };
  };
}

export async function watchPullRequests(
  runner: CommandRunner,
  db: StateDatabase,
  profile: RepoProfile,
  logger: Logger,
  intervalMs = 300_000,
): Promise<void> {
  for (;;) {
    await watchPullRequestsOnce(runner, db, profile, logger);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function watchPullRequestsOnce(
  runner: CommandRunner,
  db: StateDatabase,
  profile: RepoProfile,
  logger: Logger,
): Promise<void> {
  const prs = db.listOpenPrs(profile.profileName);
  logger.info(`Watching ${prs.length} orchestrator PRs for ${profile.profileName}`);

  for (const pr of prs) {
    const payload = await fetchPrState(
      runner,
      profile.github.owner,
      profile.github.repo,
      pr.prNumber,
    );
    const pullRequest = payload.data?.repository?.pullRequest;
    if (!pullRequest) {
      continue;
    }

    const unresolvedThreads = pullRequest.reviewThreads.nodes.filter(
      (thread) => !thread.isResolved,
    );
    const commentRecords = unresolvedThreads.flatMap((thread) =>
      thread.comments.nodes.map((comment) => ({
        externalId: comment.id,
        author: comment.author?.login ?? "unknown",
        kind: "review_thread",
        state: "UNRESOLVED",
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
    );
    const reviewRecords = pullRequest.reviews.nodes.map((review) => ({
      externalId: review.id,
      author: review.author?.login ?? "unknown",
      kind: "review",
      state: review.state,
      body: review.body ?? "",
      createdAt: review.submittedAt,
      updatedAt: review.submittedAt,
    }));

    db.replaceCommentReviews(
      profile.profileName,
      pr.prNumber,
      [...commentRecords, ...reviewRecords],
    );
    db.upsertPr({
      ...pr,
      status: pullRequest.isDraft ? "DRAFT" : "OPEN",
      mergeState: pullRequest.mergeStateStatus,
      updatedAt: nowIso(),
    });

    const needsRepair =
      pullRequest.mergeStateStatus === "DIRTY" ||
      unresolvedThreads.length > 0 ||
      pullRequest.reviews.nodes.some((review) => review.state === "CHANGES_REQUESTED");

    if (needsRepair) {
      queueRepairRunIfNeeded(db, profile.profileName, pr.issueNumber, logger);
    }
  }
}

async function fetchPrState(
  runner: CommandRunner,
  owner: string,
  repo: string,
  number: number,
): Promise<PrWatchPayload> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          number
          url
          isDraft
          mergeStateStatus
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 10) {
                nodes {
                  id
                  body
                  createdAt
                  updatedAt
                  author {
                    login
                  }
                }
              }
            }
          }
          reviews(first: 100) {
            nodes {
              id
              state
              body
              submittedAt
              author {
                login
              }
            }
          }
        }
      }
    }
  `;

  const result = await runner.run("gh", [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${repo}`,
    "-F",
    `number=${number}`,
  ]);

  return JSON.parse(result.stdout) as PrWatchPayload;
}

function queueRepairRunIfNeeded(
  db: StateDatabase,
  profileName: string,
  issueNumber: number,
  logger: Logger,
): void {
  const alreadyQueued = db
    .getIssueRuns(profileName, issueNumber)
    .some((run) => run.phase === "repair" && (run.status === "queued" || run.status === "running"));

  if (alreadyQueued) {
    return;
  }

  const run: RunRecord = {
    runId: randomId(`repair-${profileName}-${issueNumber}`),
    profileName,
    issueNumber,
    phase: "repair",
    status: "queued",
    dryRun: false,
    startedAt: nowIso(),
    metadata: {
      reason: "Queued by PR watcher",
    },
  };

  db.insertRun(run);
  logger.warn(`Queued repair run for issue #${issueNumber} in ${profileName}`);
}
