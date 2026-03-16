import { describe, expect, test } from "vitest";

import { createLockManager } from "../src/locks.js";

import { makeTempRoot, openTestDb, removeTempRoot } from "./helpers.js";

describe("locks", () => {
  test("acquires, heartbeats, and releases leases", () => {
    const root = makeTempRoot("issue-engine-locks-");
    const db = openTestDb(root);

    try {
      const locks = createLockManager(db, "profile", 1000);
      expect(locks.acquire(123, "owner-a")).toBe(true);
      expect(locks.acquire(123, "owner-b")).toBe(false);
      expect(locks.heartbeat(123, "owner-a")).toBe(true);
      expect(locks.active()).toHaveLength(1);

      locks.release(123, "owner-a");
      expect(locks.active()).toHaveLength(0);
    } finally {
      db.close();
      removeTempRoot(root);
    }
  });
});
