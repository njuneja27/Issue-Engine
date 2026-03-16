import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AppConfig } from "../src/config.js";
import { StateDatabase } from "../src/db.js";
import type { Logger } from "../src/logging.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/shell.js";
import type { RepoProfile } from "../src/types.js";

export function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempRoot(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function copyAssetsToTempRoot(rootDir: string): void {
  const sourceRoot = resolve(process.cwd());
  cpSync(join(sourceRoot, "prompts"), join(rootDir, "prompts"), { recursive: true });
  cpSync(join(sourceRoot, "schemas"), join(rootDir, "schemas"), { recursive: true });
  cpSync(join(sourceRoot, "config"), join(rootDir, "config"), { recursive: true });
}

export function makeTestAppConfig(rootDir: string): AppConfig {
  return {
    paths: {
      rootDir,
      dbPath: join(rootDir, "state", "test.sqlite"),
      logDir: join(rootDir, "logs"),
      runLogDir: join(rootDir, "logs", "runs"),
      configDir: join(rootDir, "config"),
      profilesDir: join(rootDir, "config", "repos"),
      promptsDir: join(rootDir, "prompts"),
      schemasDir: join(rootDir, "schemas"),
      stateDir: join(rootDir, "state"),
      capacityConfigPath: join(rootDir, "config", "capacity.json"),
      capacityLocalConfigPath: join(rootDir, "config", "capacity.local.json"),
    },
    defaultLockLeaseMs: 60_000,
    logLevel: "debug",
    capacityCheck: undefined,
  };
}

export function openTestDb(rootDir: string): StateDatabase {
  const db = new StateDatabase(join(rootDir, "state", "test.sqlite"));
  db.migrate();
  return db;
}

export function makeProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    profileName: "test-profile",
    github: {
      owner: "example",
      repo: "demo",
    },
    localRepoPath: "/tmp/example-repo",
    worktreeRoot: "/tmp/example-worktrees",
    defaultBranch: "main",
    concurrency: 2,
    allowMetaIssues: false,
    branchNameTemplate: "codex/issue-{{issueNumber}}-{{slug}}",
    prTemplates: {
      title: "[Issue #{{issueNumber}}] {{issueTitle}}",
      body: "Issue {{issueNumber}}",
    },
    models: {
      planning: {
        primary: "gpt-5.4",
        fallbacks: ["gpt-5.3-codex-spark"],
        reasoningEffort: "xhigh",
      },
      review: {
        primary: "gpt-5.3-codex-spark",
        fallbacks: ["gpt-5.4"],
        reasoningEffort: "xhigh",
      },
      reconciliation: {
        primary: "gpt-5.3-codex-spark",
        fallbacks: ["gpt-5.4"],
        reasoningEffort: "xhigh",
      },
      implementation: {
        primary: "gpt-5.3-codex-spark",
        fallbacks: ["gpt-5.4"],
        reasoningEffort: "xhigh",
      },
      repair: {
        primary: "gpt-5.3-codex-spark",
        fallbacks: ["gpt-5.4"],
        reasoningEffort: "xhigh",
      },
    },
    validation: {
      base: [
        {
          name: "test",
          command: "npm test",
        },
      ],
      pathRules: [
        {
          patterns: ["src/**/*.ts"],
          commands: [
            {
              name: "build",
              command: "npm run build",
            },
          ],
        },
      ],
    },
    labels: {
      priorityMap: {
        "priority:high": 100,
        "priority:medium": 50,
      },
      epic: ["epic"],
      skip: ["skip"],
      meta: ["meta"],
    },
    dependencyOverrides: [],
    llmDependencyNormalization: {
      enabled: false,
      confidenceThreshold: 0.9,
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
    },
    ...overrides,
  };
}

export const testLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  constructor(
    private readonly handlers: Record<
      string,
      (args: string[], options: CommandOptions | undefined) => CommandResult | Promise<CommandResult>
    >,
  ) {}

  async run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const key = [command, ...args.slice(0, 2)].join(" ");
    this.calls.push({
      command,
      args,
      cwd: options?.cwd ?? process.cwd(),
    });

    const handler = this.handlers[key] ?? this.handlers[command];
    if (!handler) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }

    return await handler(args, options);
  }
}
