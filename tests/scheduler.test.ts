import { listReadyIssues } from "../src/scheduler.js";
import { describe, expect, test } from "vitest";

import { makeProfile } from "./helpers.js";

describe("scheduler", () => {
  test("prefers leaf tasks and filters blocked or locked work", () => {
    const profile = makeProfile();
    const issues = [
      {
        profileName: profile.profileName,
        number: 1,
        title: "Epic",
        body: "",
        state: "OPEN" as const,
        labels: ["epic"],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/1",
        isEpic: true,
        isMeta: false,
        priority: 0,
      },
      {
        profileName: profile.profileName,
        number: 2,
        title: "Blocked task",
        body: "",
        state: "OPEN" as const,
        labels: ["priority:high"],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/2",
        isEpic: false,
        isMeta: false,
        priority: 100,
      },
      {
        profileName: profile.profileName,
        number: 3,
        title: "Ready task",
        body: "",
        state: "OPEN" as const,
        labels: ["priority:medium"],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/3",
        isEpic: false,
        isMeta: false,
        priority: 50,
      },
      {
        profileName: profile.profileName,
        number: 4,
        title: "Dependency",
        body: "",
        state: "OPEN" as const,
        labels: [],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/4",
        isEpic: false,
        isMeta: false,
        priority: 0,
      },
    ];
    const edges = [
      {
        profileName: profile.profileName,
        fromIssue: 2,
        toIssue: 4,
        type: "depends_on" as const,
        blocking: true,
        confidence: 1,
        source: "deterministic" as const,
      },
      {
        profileName: profile.profileName,
        fromIssue: 3,
        toIssue: 1,
        type: "subtask_of" as const,
        blocking: false,
        confidence: 1,
        source: "deterministic" as const,
      },
    ];

    const ready = listReadyIssues(
      profile,
      issues,
      edges,
      new Set<number>(),
      new Set<number>([4]),
    );

    expect(ready.map((candidate) => candidate.issue.number)).toEqual([3, 1]);
  });
});
