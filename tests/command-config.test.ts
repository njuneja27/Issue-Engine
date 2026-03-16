import { describe, expect, test } from "vitest";

import {
  commandInputSchema,
  commandToString,
  parseCommandInput,
} from "../src/command-config.js";

describe("command-config parsing and validation", () => {
  test("parses a safe legacy string command", () => {
    const parsed = parseCommandInput("npm test -- --runInBand");
    expect(parsed).toEqual({
      command: "npm",
      args: ["test", "--", "--runInBand"],
    });
    expect(commandToString({ command: "npm", args: ["test", "--", "--runInBand"] })).toBe(
      "npm test -- --runInBand",
    );
  });

  test("parses a safe structured command", () => {
    const parsed = parseCommandInput({
      command: "npm",
      args: ["run", "build"],
    });
    expect(parsed).toEqual({
      command: "npm",
      args: ["run", "build"],
    });
  });

  test("rejects shell metacharacters in legacy commands", () => {
    expect(() => parseCommandInput("npm test; rm -rf /")).toThrow(
      "Command contains unsafe shell syntax",
    );
    expect(() =>
      parseCommandInput("echo $(git rev-parse HEAD)"),
    ).toThrow("Command contains unsafe shell syntax");
  });

  test("rejects shell metacharacters in structured command args", () => {
    expect(() =>
      parseCommandInput({
        command: "npm",
        args: ["test", "foo;rm -rf /"],
      }),
    ).toThrow("Command contains unsafe shell syntax");
  });

  test("supports schema-safe legacy and structured command values", () => {
    expect(commandInputSchema.parse("npm test")).toBe("npm test");
    expect(
      commandInputSchema.parse({
        command: "npm",
        args: ["test", "--", "--runInBand"],
      }),
    ).toEqual({
      command: "npm",
      args: ["test", "--", "--runInBand"],
    });
    expect(() => commandInputSchema.parse("npm test && echo hacked")).toThrow();
  });
});
