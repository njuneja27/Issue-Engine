import type { CommandInput } from "./command-config.js";

export type RunPhase =
  | "planning"
  | "clarification"
  | "review"
  | "reconciliation"
  | "implementation"
  | "validation"
  | "commit"
  | "create_pr"
  | "repair";

export type ModelRunPhase =
  | "planning"
  | "review"
  | "reconciliation"
  | "implementation"
  | "repair";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export type ClarificationQuestionType = "multiple_choice" | "yes_no" | "short_freeform";

export type PlannerDisposition = "ready_to_implement" | "needs_clarification" | "blocked";

export type ClarificationQuestionStatus = "pending" | "answered";

export type IssueEdgeType =
  | "depends_on"
  | "blocks"
  | "subtask_of"
  | "epic_of"
  | "related";

export interface ModelPolicy {
  primary: string;
  fallbacks?: string[] | undefined;
  reasoningEffort: ReasoningEffort;
}

export interface ValidationCommand {
  name: string;
  command: CommandInput;
  optional?: boolean | undefined;
}

export interface ValidationPathRule {
  patterns: string[];
  commands: ValidationCommand[];
}

export interface LabelRules {
  priorityMap: Record<string, number>;
  epic: string[];
  skip: string[];
  meta?: string[] | undefined;
}

export interface DependencyOverride {
  fromIssue: number;
  toIssue: number;
  type: IssueEdgeType;
  blocking?: boolean | undefined;
  confidence?: number | undefined;
  note?: string | undefined;
}

export interface RepoProfile {
  profileName: string;
  description?: string | undefined;
  github: {
    owner: string;
    repo: string;
  };
  localRepoPath: string;
  worktreeRoot: string;
  defaultBranch: string;
  concurrency: number;
  allowMetaIssues?: boolean | undefined;
  codex?: {
    allowBypassApprovalsAndSandbox?: boolean | undefined;
  } | undefined;
  branchNameTemplate: string;
  prTemplates: {
    title: string;
    body: string;
  };
  models: Record<ModelRunPhase, ModelPolicy>;
  validation: {
    base: ValidationCommand[];
    pathRules?: ValidationPathRule[] | undefined;
  };
  labels: LabelRules;
  dependencyOverrides?: DependencyOverride[] | undefined;
  llmDependencyNormalization?: {
    enabled: boolean;
    confidenceThreshold?: number | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
  } | undefined;
}

export interface GitHubIssue {
  profileName: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  author?: string | undefined;
  updatedAt: string;
  url: string;
  isEpic: boolean;
  isMeta: boolean;
  priority: number;
  raw?: unknown | undefined;
}

export interface IssueEdge {
  profileName: string;
  fromIssue: number;
  toIssue: number;
  type: IssueEdgeType;
  blocking: boolean;
  confidence: number;
  source: "deterministic" | "manual" | "llm";
  note?: string | undefined;
}

export interface IssueSnapshot {
  issue: GitHubIssue;
  blockers: IssueEdge[];
  dependents: IssueEdge[];
  activeRun?: RunRecord | undefined;
  activeLock?: LockRecord | undefined;
}

export interface LockRecord {
  profileName: string;
  issueNumber: number;
  owner: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  createdAt: string;
}

export interface RunRecord {
  runId: string;
  profileName: string;
  issueNumber: number;
  phase: RunPhase;
  status: RunStatus;
  dryRun: boolean;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ClarificationQuestionRecord {
  runId: string;
  issueNumber: number;
  questionKey: string;
  phase: RunPhase;
  questionType: ClarificationQuestionType;
  prompt: string;
  options: string[];
  status: ClarificationQuestionStatus;
  answer: string | null;
  selectedOption: number | null;
  askedAt: string;
  answeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerClarificationQuestion {
  questionId: string;
  questionType: ClarificationQuestionType;
  question: string;
  options?: string[];
}

export interface ClarificationQuestionAnswer {
  questionId: string;
  answer: string;
  selectedOption: number | null;
}

export interface RunOutcome {
  status: "completed" | "blocked" | "failed";
}

export interface WorktreeRecord {
  profileName: string;
  issueNumber: number;
  branchName: string;
  path: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestRecord {
  profileName: string;
  issueNumber: number;
  runId: string;
  prNumber: number;
  url: string;
  branchName: string;
  status: string;
  mergeState?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerCandidate {
  issue: GitHubIssue;
  blockedBy: number[];
  reason?: string | undefined;
  score: number;
}

export interface PlannerOutput {
  summary: string;
  disposition: PlannerDisposition;
  assumptions: string[];
  implementationSteps: string[];
  validationPlan: string[];
  risks: string[];
  clarificationQuestions?: Array<{
    questionId: string;
    questionType: ClarificationQuestionType;
    question: string;
    options?: string[];
  }>;
}

export interface ReviewerOutput {
  verdict: "approved" | "revise";
  summary: string;
  findings: string[];
  requiredChanges: string[];
  validationGaps: string[];
}

export interface ImplementationOutput {
  summary: string;
  status: "implemented" | "no_changes" | "blocked";
  changedFiles: string[];
  validationCommands: string[];
  followUps: string[];
}

export interface ReconciledPlan extends PlannerOutput {
  reviewerSummary: string;
  reviewerFindings: string[];
}
