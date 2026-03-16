import { z } from "zod";

const modelPolicySchema = z.object({
  primary: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
});

const validationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  optional: z.boolean().optional(),
});

const validationPathRuleSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1),
  commands: z.array(validationCommandSchema).min(1),
});

const dependencyOverrideSchema = z.object({
  fromIssue: z.number().int().positive(),
  toIssue: z.number().int().positive(),
  type: z.enum(["depends_on", "blocks", "subtask_of", "epic_of", "related"]),
  blocking: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
});

export const repoProfileSchema = z.object({
  profileName: z.string().min(1),
  description: z.string().optional(),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  localRepoPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  defaultBranch: z.string().min(1),
  concurrency: z.number().int().positive(),
  allowMetaIssues: z.boolean().optional(),
  branchNameTemplate: z.string().min(1),
  prTemplates: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
  }),
  models: z.object({
    planning: modelPolicySchema,
    review: modelPolicySchema,
    reconciliation: modelPolicySchema,
    implementation: modelPolicySchema,
    repair: modelPolicySchema,
  }),
  validation: z.object({
    base: z.array(validationCommandSchema),
    pathRules: z.array(validationPathRuleSchema).optional(),
  }),
  labels: z.object({
    priorityMap: z.record(z.string(), z.number().int()),
    epic: z.array(z.string()),
    skip: z.array(z.string()),
    meta: z.array(z.string()).optional(),
  }),
  dependencyOverrides: z.array(dependencyOverrideSchema).optional(),
  llmDependencyNormalization: z
    .object({
      enabled: z.boolean(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
      model: z.string().min(1).optional(),
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    })
    .optional(),
});

export type RepoProfileInput = z.input<typeof repoProfileSchema>;
