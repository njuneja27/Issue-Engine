import { buildIssueGraph } from "../src/issue-graph.js";
import { describe, expect, test } from "vitest";

import { makeProfile } from "./helpers.js";

describe("issue graph", () => {
  test("parses deterministic dependencies, blocking edges, and manual overrides", async () => {
    const profile = makeProfile({
      dependencyOverrides: [
        {
          fromIssue: 5,
          toIssue: 2,
          type: "depends_on",
          blocking: true,
        },
      ],
    });

    const issues = [
      {
        profileName: profile.profileName,
        number: 2,
        title: "Core API",
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
        title: "UI update",
        body: "Blocked by #2\nSubtask of #9",
        state: "OPEN" as const,
        labels: [],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/3",
        isEpic: false,
        isMeta: false,
        priority: 0,
      },
      {
        profileName: profile.profileName,
        number: 4,
        title: "Foundation work",
        body: "Blocks #3",
        state: "OPEN" as const,
        labels: [],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/4",
        isEpic: false,
        isMeta: false,
        priority: 0,
      },
      {
        profileName: profile.profileName,
        number: 5,
        title: "Follow-up",
        body: "Mentions #2",
        state: "OPEN" as const,
        labels: [],
        assignees: [],
        updatedAt: "2026-03-16T00:00:00.000Z",
        url: "https://example.com/5",
        isEpic: false,
        isMeta: false,
        priority: 0,
      },
    ];

    const edges = await buildIssueGraph(profile, issues);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromIssue: 3,
          toIssue: 2,
          type: "depends_on",
          blocking: true,
        }),
        expect.objectContaining({
          fromIssue: 3,
          toIssue: 9,
          type: "subtask_of",
          blocking: false,
        }),
        expect.objectContaining({
          fromIssue: 4,
          toIssue: 3,
          type: "blocks",
          blocking: true,
        }),
        expect.objectContaining({
          fromIssue: 5,
          toIssue: 2,
          type: "depends_on",
          source: "manual",
        }),
      ]),
    );
  });
});
