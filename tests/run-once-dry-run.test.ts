import { describe, expect, test } from "vitest";

import { CodexClient } from "../src/codex.js";
import { runOnce } from "../src/pipeline.js";

import {
  FakeRunner,
  copyAssetsToTempRoot,
  makeProfile,
  makeTempRoot,
  makeTestAppConfig,
  openTestDb,
  removeTempRoot,
  testLogger,
} from "./helpers.js";

describe("run-once dry-run", () => {
  test("completes without mutating a target repository", async () => {
    const root = makeTempRoot("issue-engine-dry-run-");
    copyAssetsToTempRoot(root);
    const appConfig = makeTestAppConfig(root);
    const db = openTestDb(root);
    const profile = makeProfile({
      localRepoPath: "/tmp/does-not-need-to-exist",
      worktreeRoot: "/tmp/does-not-need-to-exist-worktrees",
    });

    const fakeIssuePayload = [
      {
        number: 101,
        title: "Implement reporting endpoint",
        body: "Blocked by #100",
        state: "OPEN",
        labels: [{ name: "priority:medium" }],
        assignees: [],
        author: { login: "octocat" },
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/101",
      },
      {
        number: 100,
        title: "Create API scaffold",
        body: "",
        state: "OPEN",
        labels: [{ name: "priority:high" }],
        assignees: [],
        author: { login: "octocat" },
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/100",
      },
      {
        number: 102,
        title: "Meta discussion",
        body: "",
        state: "OPEN",
        labels: [{ name: "meta" }],
        assignees: [],
        author: { login: "octocat" },
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/102",
      }
    ];

    const runner = new FakeRunner({
      "gh issue list": (args, options) => ({
        command: "gh",
        args,
        cwd: options?.cwd ?? process.cwd(),
        stdout: JSON.stringify(fakeIssuePayload),
        stderr: "",
        exitCode: 0,
      }),
    });
    const codex = new CodexClient(appConfig, runner, testLogger);

    try {
      const result = await runOnce({
        profile,
        appConfig,
        db,
        logger: testLogger,
        runner,
        codex,
        dryRun: true,
      });

      expect(result.issue.number).toBe(100);
      expect(result.pr?.url).toContain("/pull/dry-run");
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.command).toBe("gh");
      expect(db.getIssueRuns(profile.profileName, 100)[0]?.status).toBe("succeeded");
    } finally {
      db.close();
      removeTempRoot(root);
    }
  });
});
