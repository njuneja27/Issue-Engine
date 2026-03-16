import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listRepoProfiles, loadAppConfig, loadRepoProfile } from "../src/config.js";
import { describe, expect, test } from "vitest";

import { makeTempRoot, removeTempRoot } from "./helpers.js";

describe("config loading", () => {
  test("loads the sample repo profile", () => {
    const rootDir = process.cwd();
    const profile = loadRepoProfile(
      {
        paths: {
          rootDir,
          dbPath: "",
          logDir: "",
          runLogDir: "",
          configDir: `${rootDir}/config`,
          profilesDir: `${rootDir}/config/repos`,
          promptsDir: `${rootDir}/prompts`,
          schemasDir: `${rootDir}/schemas`,
          stateDir: `${rootDir}/state`,
          capacityConfigPath: `${rootDir}/config/capacity.json`,
          capacityLocalConfigPath: `${rootDir}/config/capacity.local.json`,
        },
        defaultLockLeaseMs: 60_000,
        logLevel: "info",
        capacityCheck: undefined,
      },
      "sample",
    );

    expect(profile.profileName).toBe("sample");
    expect(profile.models.planning.primary).toBe("gpt-5.4");
    expect(profile.models.implementation.primary).toBe("gpt-5.3-codex-spark");
  });

  test("prefers .local repo profiles and loads local capacity config", () => {
    const root = makeTempRoot("issue-engine-config-");

    try {
      mkdirSync(join(root, "config", "repos"), { recursive: true });
      writeFileSync(
        join(root, "config", "repos", "demo.local.json"),
        JSON.stringify(
          {
            profileName: "demo",
            github: {
              owner: "local-owner",
              repo: "local-repo",
            },
            localRepoPath: "/tmp/local",
            worktreeRoot: "/tmp/local-worktrees",
            defaultBranch: "main",
            concurrency: 1,
            branchNameTemplate: "codex/issue-{{issueNumber}}-{{slug}}",
            prTemplates: {
              title: "demo",
              body: "demo",
            },
            models: {
              planning: {
                primary: "gpt-5.4",
                reasoningEffort: "xhigh",
              },
              review: {
                primary: "gpt-5.3-codex-spark",
                reasoningEffort: "xhigh",
              },
              reconciliation: {
                primary: "gpt-5.3-codex-spark",
                reasoningEffort: "xhigh",
              },
              implementation: {
                primary: "gpt-5.3-codex-spark",
                reasoningEffort: "xhigh",
              },
              repair: {
                primary: "gpt-5.3-codex-spark",
                reasoningEffort: "xhigh",
              },
            },
            validation: {
              base: [],
            },
            labels: {
              priorityMap: {},
              epic: [],
              skip: [],
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(root, "config", "capacity.local.json"),
        JSON.stringify(
          {
            enabled: true,
            command: "codex login status",
            minRemainingPercent: 5,
          },
          null,
          2,
        ),
      );

      const appConfig = loadAppConfig(root);
      const profile = loadRepoProfile(appConfig, "demo");

      expect(profile.github.owner).toBe("local-owner");
      expect(listRepoProfiles(appConfig)).toContain("demo");
      expect(appConfig.capacityCheck?.enabled).toBe(true);
      expect(appConfig.capacityCheck?.command).toBe("codex login status");
    } finally {
      removeTempRoot(root);
    }
  });
});
