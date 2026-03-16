import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CodexClient } from "../src/codex.js";
import type { Logger } from "../src/logging.js";
import {
  FakeRunner,
  makeProfile,
  makeTestAppConfig,
} from "./helpers.js";

const makeRunDir = () => mkdtempSync(join(tmpdir(), "issue-engine-codex-"));

describe("CodexClient command execution", () => {
  test("runs without bypass flag when profile does not opt in", async () => {
    const runDir = makeRunDir();
    const appConfig = makeTestAppConfig(runDir);
    const profile = makeProfile();
    const warnings: string[] = [];
    const logger: Logger = {
      info() {},
      error() {},
      debug() {},
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    const runner = new FakeRunner({
      "codex exec --model": (args, options) => {
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        const outputPath = args[args.indexOf("-o") + 1];
        writeFileSync(
          String(outputPath),
          JSON.stringify({
            summary: "test summary",
            assumptions: ["a"],
            implementationSteps: ["step"],
            validationPlan: ["validate"],
            risks: ["risk"],
          }),
        );
        return {
          command: "codex",
          args,
          cwd: options?.cwd ?? process.cwd(),
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const codex = new CodexClient(appConfig, runner, logger);

    const result = await codex.runPlanner(
      profile,
      "prompt",
      runDir,
      runDir,
      false,
    );

    expect(runner.calls).toHaveLength(1);
    expect(result.output.summary).toBe("test summary");
    expect(warnings).toHaveLength(0);
  });

  test("adds bypass flag when profile explicitly enables it", async () => {
    const runDir = makeRunDir();
    const appConfig = makeTestAppConfig(runDir);
    const profile = makeProfile({
      codex: {
        allowBypassApprovalsAndSandbox: true,
      },
    });
    const runner = new FakeRunner({
      "codex exec --model": (args, options) => {
        expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
        const outputPath = args[args.indexOf("-o") + 1];
        writeFileSync(
          String(outputPath),
          JSON.stringify({
            verdict: "approved",
            summary: "test summary",
            findings: [],
            requiredChanges: [],
            validationGaps: [],
          }),
        );
        return {
          command: "codex",
          args,
          cwd: options?.cwd ?? process.cwd(),
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const codex = new CodexClient(appConfig, runner, {
      info() {},
      error() {},
      debug() {},
      warn() {},
    });

    const result = await codex.runReviewer(
      profile,
      "prompt",
      runDir,
      runDir,
      false,
    );

    expect(runner.calls).toHaveLength(1);
    expect(result.output.verdict).toBe("approved");
  });

  test("uses dry-run path without invoking codex and without requiring bypass", async () => {
    const runDir = makeRunDir();
    const appConfig = makeTestAppConfig(runDir);
    const profile = makeProfile({
      codex: {
        allowBypassApprovalsAndSandbox: true,
      },
    });
    const runner = new FakeRunner({});
    const codex = new CodexClient(appConfig, runner, {
      info() {},
      error() {},
      debug() {},
      warn() {},
    });

    const result = await codex.runImplementer(
      profile,
      "prompt",
      runDir,
      runDir,
      true,
    );

    expect(runner.calls).toHaveLength(0);
    expect(result.modelUsed).toBe("dry-run");
  });
});
