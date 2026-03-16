import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logging.js";
import type { CommandRunner } from "./shell.js";
import { ShellError } from "./shell.js";
import type {
  AmbiguousReference,
  AmbiguousReferenceNormalizer,
} from "./issue-graph.js";
import type {
  GitHubIssue,
  ImplementationOutput,
  ModelPolicy,
  PlannerOutput,
  ReconciledPlan,
  RepoProfile,
  ReviewerOutput,
} from "./types.js";
import { formatJson, normalizeNewlines, writeTextFile } from "./utils.js";

export interface StructuredCodexRun<T> {
  output: T;
  modelUsed: string;
  promptPath: string;
  responsePath: string;
}

export class CodexClient {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly runner: CommandRunner,
    private readonly logger: Logger,
  ) {}

  async runPlanner(
    profile: RepoProfile,
    prompt: string,
    runDir: string,
    cwd: string,
    dryRun: boolean,
  ): Promise<StructuredCodexRun<PlannerOutput>> {
    return this.runStructured<PlannerOutput>({
      phase: "planning",
      profile,
      prompt,
      runDir,
      cwd,
      schemaFile: "planner-output.schema.json",
      dryRun,
      dryRunOutput: {
        summary: "Dry-run planner output.",
        assumptions: ["No repository mutations were performed."],
        implementationSteps: [
          "Inspect the target repo and confirm issue scope.",
          "Make the minimal code changes needed for the issue.",
          "Run profile-selected validation commands.",
        ],
        validationPlan: ["Run base validation commands from the repo profile."],
        risks: ["Plan not executed because dry-run mode is enabled."],
      },
    });
  }

  async runReviewer(
    profile: RepoProfile,
    prompt: string,
    runDir: string,
    cwd: string,
    dryRun: boolean,
  ): Promise<StructuredCodexRun<ReviewerOutput>> {
    return this.runStructured<ReviewerOutput>({
      phase: "review",
      profile,
      prompt,
      runDir,
      cwd,
      schemaFile: "reviewer-output.schema.json",
      dryRun,
      dryRunOutput: {
        verdict: "approved",
        summary: "Dry-run reviewer approved the plan.",
        findings: [],
        requiredChanges: [],
        validationGaps: [],
      },
    });
  }

  async runImplementer(
    profile: RepoProfile,
    prompt: string,
    runDir: string,
    cwd: string,
    dryRun: boolean,
  ): Promise<StructuredCodexRun<ImplementationOutput>> {
    return this.runStructured<ImplementationOutput>({
      phase: "implementation",
      profile,
      prompt,
      runDir,
      cwd,
      schemaFile: "implementer-output.schema.json",
      dryRun,
      dryRunOutput: {
        summary: "Dry-run implementer made no changes.",
        status: "no_changes",
        changedFiles: [],
        validationCommands: [],
        followUps: [],
      },
    });
  }

  createDependencyNormalizer(): AmbiguousReferenceNormalizer {
    return {
      normalize: async (profile, ambiguous) => {
        const prompt = buildDependencyNormalizationPrompt(profile, ambiguous);
        const response = await this.runStructured<{
          edges: Array<{
            fromIssue: number;
            toIssue: number;
            type: "depends_on" | "blocks" | "subtask_of" | "epic_of" | "related";
            blocking: boolean;
            confidence: number;
            note?: string;
          }>;
        }>({
          phase: "reconciliation",
          profile,
          prompt,
          runDir: join(this.appConfig.paths.runLogDir, "dependency-normalization"),
          cwd: this.appConfig.paths.rootDir,
          schemaFile: "dependency-normalization.schema.json",
          dryRun: false,
          dryRunOutput: { edges: [] },
          policyOverride: {
            primary:
              profile.llmDependencyNormalization?.model ??
              profile.models.planning.primary,
            fallbacks: profile.models.planning.fallbacks,
            reasoningEffort:
              profile.llmDependencyNormalization?.reasoningEffort ??
              profile.models.planning.reasoningEffort,
          },
        });

        return response.output.edges.map((edge) => ({
          profileName: profile.profileName,
          ...edge,
          source: "llm" as const,
        }));
      },
    };
  }

  reconcilePlan(
    plannerOutput: PlannerOutput,
    reviewerOutput: ReviewerOutput,
  ): ReconciledPlan {
    const implementationSteps =
      reviewerOutput.requiredChanges.length > 0
        ? [...plannerOutput.implementationSteps, ...reviewerOutput.requiredChanges]
        : plannerOutput.implementationSteps;

    const validationPlan = [
      ...plannerOutput.validationPlan,
      ...reviewerOutput.validationGaps,
    ];

    return {
      ...plannerOutput,
      implementationSteps: uniqueStrings(implementationSteps),
      validationPlan: uniqueStrings(validationPlan),
      reviewerSummary: reviewerOutput.summary,
      reviewerFindings: reviewerOutput.findings,
    };
  }

  private async runStructured<T>(options: {
    phase: "planning" | "review" | "reconciliation" | "implementation" | "repair";
    profile: RepoProfile;
    prompt: string;
    runDir: string;
    cwd: string;
    schemaFile: string;
    dryRun: boolean;
    dryRunOutput: T;
    policyOverride?: ModelPolicy;
  }): Promise<StructuredCodexRun<T>> {
    const promptPath = join(options.runDir, `${options.phase}.prompt.md`);
    const responsePath = join(options.runDir, `${options.phase}.response.json`);
    writeTextFile(promptPath, normalizeNewlines(options.prompt));

    if (options.dryRun) {
      writeTextFile(responsePath, formatJson(options.dryRunOutput));
      return {
        output: options.dryRunOutput,
        modelUsed: "dry-run",
        promptPath,
        responsePath,
      };
    }

    const policy = options.policyOverride ?? options.profile.models[options.phase];
    const models = [policy.primary, ...(policy.fallbacks ?? [])];
    const schemaPath = join(this.appConfig.paths.schemasDir, options.schemaFile);
    let lastError: unknown;

    for (const model of models) {
      try {
        const result = await this.runner.run(
          "codex",
          [
            "exec",
            "--model",
            model,
            "-c",
            `model_reasoning_effort="${policy.reasoningEffort}"`,
            "--dangerously-bypass-approvals-and-sandbox",
            "-C",
            options.cwd,
            "--output-schema",
            schemaPath,
            "-o",
            responsePath,
            "--color",
            "never",
            "-",
          ],
          {
            cwd: options.cwd,
            input: options.prompt,
          },
        );

        if (!existsSync(responsePath)) {
          throw new Error(
            `Codex run completed without writing structured output. Stdout: ${result.stdout}`,
          );
        }

        const output = JSON.parse(normalizeNewlines(readFileSync(responsePath, "utf8"))) as T;
        return {
          output,
          modelUsed: model,
          promptPath,
          responsePath,
        };
      } catch (error) {
        lastError = error;
        if (
          model !== models[models.length - 1] &&
          looksLikeModelAvailabilityError(error)
        ) {
          this.logger.warn(
            `Model ${model} unavailable for ${options.phase}; trying configured fallback`,
          );
          continue;
        }
        break;
      }
    }

    throw new Error(
      `Codex ${options.phase} failed for profile ${options.profile.profileName}. ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}

function looksLikeModelAvailabilityError(error: unknown): boolean {
  const message =
    error instanceof ShellError
      ? `${error.result.stderr}\n${error.result.stdout}`
      : error instanceof Error
        ? error.message
        : String(error);

  return /model|unavailable|unknown|not found|unsupported/i.test(message);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildDependencyNormalizationPrompt(
  profile: RepoProfile,
  ambiguous: AmbiguousReference[],
): string {
  const issueBlock = ambiguous
    .map(
      (item) => `Issue #${item.issue.number}: ${item.issue.title}
References: ${item.references.map((value) => `#${value}`).join(", ")}
Body:
${item.issue.body || "(empty)"}`,
    )
    .join("\n\n---\n\n");

  return `You are normalizing ambiguous GitHub issue relationships for an orchestration controller.

Repository profile: ${profile.profileName}
Repository: ${profile.github.owner}/${profile.github.repo}

Only infer relationships when the text clearly supports them.
If confidence is low, return "related" with blocking=false.
Never invent issue numbers.

Return JSON that satisfies the provided schema.

${issueBlock}
`;
}
