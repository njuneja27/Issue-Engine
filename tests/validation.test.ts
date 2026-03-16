import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runValidationCommands } from "../src/validation.js";
import { FakeRunner, makeProfile } from "./helpers.js";

describe("runValidationCommands", () => {
  const makeWorktree = () =>
    mkdtempSync(join(tmpdir(), "issue-engine-validation-"));

  const withWorktree = (fn: (path: string) => Promise<void> | void) => async () => {
    const worktree = makeWorktree();
    try {
      await fn(worktree);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  };

  test(
    "installs dependencies when package-lock exists and dependency marker is missing",
    withWorktree(async (worktreePath) => {
      writeFileSync(join(worktreePath, "package-lock.json"), "{}");

      const logs: string[] = [];
      const logger = {
        info: (message: string) => logs.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
      };

      const profile = makeProfile();
      const runner = new FakeRunner({
        "sh -lc npm ci": () => ({
          command: "sh",
          args: ["-lc", "npm ci"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
        "sh -lc npm test": () => ({
          command: "sh",
          args: ["-lc", "npm test"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      });

      const result = await runValidationCommands(runner, profile, worktreePath, [
        { name: "test", command: "npm test" },
      ], logger, false);

      expect(runner.calls.map((item) => item.args.join(" "))).toEqual([
        "-lc npm ci",
        "-lc npm test",
      ]);
      expect(logs).toContain(
        `Running npm ci in ${worktreePath} before validation commands`,
      );
      expect(result).toEqual([
        { name: "test", command: "npm test", status: "passed" },
      ]);
    }),
  );

  test(
    "skips dependency install when node_modules/.package-lock.json exists",
    withWorktree(async (worktreePath) => {
      writeFileSync(join(worktreePath, "package-lock.json"), "{}");
      mkdirSync(join(worktreePath, "node_modules"), { recursive: true });
      writeFileSync(join(worktreePath, "node_modules", ".package-lock.json"), "{}");

      const logs: string[] = [];
      const logger = {
        info: (message: string) => logs.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
      };

      const profile = makeProfile();
      const runner = new FakeRunner({
        "sh -lc npm test": () => ({
          command: "sh",
          args: ["-lc", "npm test"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      });

      const result = await runValidationCommands(runner, profile, worktreePath, [
        { name: "test", command: "npm test" },
      ], logger, false);

      expect(runner.calls.map((item) => item.args.join(" "))).toEqual([
        "-lc npm test",
      ]);
      expect(logs).toContain(
        "Dependency bootstrap skipped: node_modules/.package-lock.json is present",
      );
      expect(result).toEqual([
        { name: "test", command: "npm test", status: "passed" },
      ]);
    }),
  );

  test(
    "skips bootstrap and validation commands on dry-run",
    withWorktree(async (worktreePath) => {
      writeFileSync(join(worktreePath, "package-lock.json"), "{}");

      const profile = makeProfile();
      const runner = new FakeRunner({});

      const result = await runValidationCommands(runner, profile, worktreePath, [
        { name: "test", command: "npm test" },
      ], fakeLogger(), true);

      expect(runner.calls).toHaveLength(0);
      expect(result).toEqual([
        { name: "test", command: "npm test", status: "skipped" },
      ]);
    }),
  );

  test(
    "skips npm install when ISSUE_ENGINE_SKIP_NODE_INSTALL=true",
    withWorktree(async (worktreePath) => {
      writeFileSync(join(worktreePath, "package-lock.json"), "{}");

      const previous = process.env.ISSUE_ENGINE_SKIP_NODE_INSTALL;
      process.env.ISSUE_ENGINE_SKIP_NODE_INSTALL = "true";

      const logs: string[] = [];
      const logger = {
        info: (message: string) => logs.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
      };

      const profile = makeProfile();
      const runner = new FakeRunner({
        "sh -lc npm test": () => ({
          command: "sh",
          args: ["-lc", "npm test"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      });

      try {
        const result = await runValidationCommands(runner, profile, worktreePath, [
          { name: "test", command: "npm test" },
        ], logger, false);

        expect(runner.calls.map((item) => item.args.join(" "))).toEqual(["-lc npm test"]);
        expect(logs).toContain(
          "Dependency bootstrap skipped: ISSUE_ENGINE_SKIP_NODE_INSTALL=true",
        );
        expect(result).toEqual([
          { name: "test", command: "npm test", status: "passed" },
        ]);
      } finally {
        if (previous === undefined) {
          delete process.env.ISSUE_ENGINE_SKIP_NODE_INSTALL;
        } else {
          process.env.ISSUE_ENGINE_SKIP_NODE_INSTALL = previous;
        }
      }
    }),
  );

  test(
    "keeps optional validation failures non-blocking after install succeeds",
    withWorktree(async (worktreePath) => {
      writeFileSync(join(worktreePath, "package-lock.json"), "{}");
      const logs: string[] = [];
      const logger = {
        info: (message: string) => logs.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
      };

      const profile = makeProfile();
      const runner = new FakeRunner({
        "sh -lc npm ci": () => ({
          command: "sh",
          args: ["-lc", "npm ci"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
        "sh -lc npm test": () => {
          throw new Error("validation failed");
        },
        "sh -lc npm run build": () => ({
          command: "sh",
          args: ["-lc", "npm run build"],
          cwd: worktreePath,
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      });

      const result = await runValidationCommands(runner, profile, worktreePath, [
        { name: "test", command: "npm test", optional: true },
        { name: "build", command: "npm run build" },
      ], logger, false);

      expect(logs).toContain(
        `Running npm ci in ${worktreePath} before validation commands`,
      );
      expect(runner.calls.map((item) => item.args.join(" "))).toEqual([
        "-lc npm ci",
        "-lc npm test",
        "-lc npm run build",
      ]);
      expect(result).toEqual([
        { name: "test", command: "npm test", status: "failed" },
        { name: "build", command: "npm run build", status: "passed" },
      ]);
    }),
  );
});

const fakeLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});
