import type { Logger } from "./logging.js";
import type { GitHubIssue, IssueEdge, RepoProfile } from "./types.js";
import { unique } from "./utils.js";

export interface AmbiguousReference {
  issue: GitHubIssue;
  references: number[];
}

export interface AmbiguousReferenceNormalizer {
  normalize(
    profile: RepoProfile,
    ambiguous: AmbiguousReference[],
  ): Promise<IssueEdge[]>;
}

const dependencyPatterns: Array<{
  regex: RegExp;
  build: (issueNumber: number, matchNumber: number) => IssueEdge;
}> = [
  {
    regex: /\b(?:blocked by|depends on|requires|after)\s+#(\d+)\b/gi,
    build: (issueNumber, matchNumber) => ({
      profileName: "",
      fromIssue: issueNumber,
      toIssue: matchNumber,
      type: "depends_on",
      blocking: true,
      confidence: 1,
      source: "deterministic",
    }),
  },
  {
    regex: /\b(?:blocks|unblocks)\s+#(\d+)\b/gi,
    build: (issueNumber, matchNumber) => ({
      profileName: "",
      fromIssue: issueNumber,
      toIssue: matchNumber,
      type: "blocks",
      blocking: true,
      confidence: 1,
      source: "deterministic",
    }),
  },
  {
    regex: /\b(?:subtask of|child of|part of|parent issue)\s+#(\d+)\b/gi,
    build: (issueNumber, matchNumber) => ({
      profileName: "",
      fromIssue: issueNumber,
      toIssue: matchNumber,
      type: "subtask_of",
      blocking: false,
      confidence: 0.95,
      source: "deterministic",
    }),
  },
  {
    regex: /\b(?:epic|parent|umbrella)\s+#(\d+)\b/gi,
    build: (issueNumber, matchNumber) => ({
      profileName: "",
      fromIssue: issueNumber,
      toIssue: matchNumber,
      type: "subtask_of",
      blocking: false,
      confidence: 0.9,
      source: "deterministic",
    }),
  },
];

export async function buildIssueGraph(
  profile: RepoProfile,
  issues: GitHubIssue[],
  logger?: Logger,
  normalizer?: AmbiguousReferenceNormalizer,
): Promise<IssueEdge[]> {
  const edges = new Map<string, IssueEdge>();
  const ambiguous: AmbiguousReference[] = [];

  for (const issue of issues) {
    const text = `${issue.title}\n\n${issue.body}`;
    const matched = new Set<number>();

    for (const pattern of dependencyPatterns) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const raw = Number(match[1]);
        if (!Number.isInteger(raw) || raw <= 0 || raw === issue.number) {
          continue;
        }
        matched.add(raw);
        const built = pattern.build(issue.number, raw);
        addEdge(edges, {
          ...built,
          profileName: profile.profileName,
        });
      }
    }

    const referenced = unique(
      Array.from(text.matchAll(/#(\d+)\b/g), (match) => Number(match[1])).filter(
        (value) => Number.isInteger(value) && value > 0 && value !== issue.number,
      ),
    );

    const ambiguousRefs = referenced.filter((value) => !matched.has(value));
    for (const reference of ambiguousRefs) {
      addEdge(edges, {
        profileName: profile.profileName,
        fromIssue: issue.number,
        toIssue: reference,
        type: "related",
        blocking: false,
        confidence: 0.35,
        source: "deterministic",
        note: "generic issue reference",
      });
    }

    if (ambiguousRefs.length > 0) {
      ambiguous.push({
        issue,
        references: ambiguousRefs,
      });
    }
  }

  for (const override of profile.dependencyOverrides ?? []) {
    addEdge(edges, {
      profileName: profile.profileName,
      fromIssue: override.fromIssue,
      toIssue: override.toIssue,
      type: override.type,
      blocking:
        override.blocking ??
        (override.type === "depends_on" || override.type === "blocks"),
      confidence: override.confidence ?? 1,
      source: "manual",
      note: override.note,
    });
  }

  if (
    profile.llmDependencyNormalization?.enabled &&
    normalizer &&
    ambiguous.length > 0
  ) {
    logger?.info(
      `Running LLM dependency normalization for ${ambiguous.length} issues in ${profile.profileName}`,
    );

    const normalized = await normalizer.normalize(profile, ambiguous);
    const threshold = profile.llmDependencyNormalization.confidenceThreshold ?? 0.9;

    for (const edge of normalized) {
      addEdge(edges, {
        ...edge,
        profileName: profile.profileName,
        blocking: edge.blocking && edge.confidence >= threshold,
        source: "llm",
      });
    }
  }

  return Array.from(edges.values()).sort((left, right) => {
    if (left.fromIssue !== right.fromIssue) {
      return left.fromIssue - right.fromIssue;
    }
    if (left.toIssue !== right.toIssue) {
      return left.toIssue - right.toIssue;
    }
    return left.type.localeCompare(right.type);
  });
}

export function buildBlockerMap(edges: IssueEdge[]): Map<number, number[]> {
  const blockers = new Map<number, number[]>();

  for (const edge of edges) {
    if (!edge.blocking) {
      continue;
    }

    if (edge.type === "depends_on") {
      const next = blockers.get(edge.fromIssue) ?? [];
      next.push(edge.toIssue);
      blockers.set(edge.fromIssue, unique(next).sort((a, b) => a - b));
      continue;
    }

    if (edge.type === "blocks") {
      const next = blockers.get(edge.toIssue) ?? [];
      next.push(edge.fromIssue);
      blockers.set(edge.toIssue, unique(next).sort((a, b) => a - b));
    }
  }

  return blockers;
}

export function buildChildMap(edges: IssueEdge[]): Map<number, number[]> {
  const children = new Map<number, number[]>();

  for (const edge of edges) {
    if (edge.type !== "subtask_of") {
      continue;
    }

    const next = children.get(edge.toIssue) ?? [];
    next.push(edge.fromIssue);
    children.set(edge.toIssue, unique(next).sort((a, b) => a - b));
  }

  return children;
}

function addEdge(store: Map<string, IssueEdge>, edge: IssueEdge): void {
  const key = `${edge.fromIssue}:${edge.toIssue}:${edge.type}:${edge.source}`;
  const existing = store.get(key);
  if (!existing || edge.confidence >= existing.confidence) {
    store.set(key, edge);
  }
}
