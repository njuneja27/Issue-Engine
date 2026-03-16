import { describe, expect, test } from "vitest";

import { getCapacityStatus, parseCapacityOutput } from "../src/capacity.js";

import { FakeRunner, makeTempRoot, makeTestAppConfig, removeTempRoot } from "./helpers.js";

describe("capacity checks", () => {
  test("parses remaining and used percentages from status output", () => {
    expect(parseCapacityOutput("7d remaining: 4.5%")).toEqual({
      remainingPercent: 4.5,
      usedPercent: undefined,
    });

    expect(parseCapacityOutput("Usage: 96% used in current 7d window")).toEqual({
      remainingPercent: 4,
      usedPercent: 96,
    });
  });

  test("blocks new work when remaining percent is below threshold", async () => {
    const root = makeTempRoot("issue-engine-capacity-");

    try {
      const appConfig = makeTestAppConfig(root);
      appConfig.capacityCheck = {
        enabled: true,
        command: "codex login status",
        minRemainingPercent: 5,
        blockNewWork: true,
        failOpen: false,
        windowLabel: "7d",
      };

      const runner = new FakeRunner({
        sh: (args, options) => ({
          command: "sh",
          args,
          cwd: options?.cwd ?? process.cwd(),
          stdout: "7d remaining: 4.2%",
          stderr: "",
          exitCode: 0,
        }),
      });

      const status = await getCapacityStatus(appConfig, runner);
      expect(status.available).toBe(true);
      expect(status.remainingPercent).toBe(4.2);
      expect(status.shouldBlockNewWork).toBe(true);
    } finally {
      removeTempRoot(root);
    }
  });

  test("fails open when parsing is unavailable and config allows it", async () => {
    const root = makeTempRoot("issue-engine-capacity-open-");

    try {
      const appConfig = makeTestAppConfig(root);
      appConfig.capacityCheck = {
        enabled: true,
        command: "codex login status",
        minRemainingPercent: 5,
        failOpen: true,
      };

      const runner = new FakeRunner({
        sh: (args, options) => ({
          command: "sh",
          args,
          cwd: options?.cwd ?? process.cwd(),
          stdout: "Logged in using ChatGPT",
          stderr: "",
          exitCode: 0,
        }),
      });

      const status = await getCapacityStatus(appConfig, runner);
      expect(status.available).toBe(false);
      expect(status.shouldBlockNewWork).toBe(false);
    } finally {
      removeTempRoot(root);
    }
  });
});
