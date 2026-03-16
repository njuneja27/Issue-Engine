import type { StateDatabase } from "./db.js";
import type { LockRecord } from "./types.js";

export interface LockManager {
  acquire(issueNumber: number, owner: string): boolean;
  heartbeat(issueNumber: number, owner: string): boolean;
  release(issueNumber: number, owner?: string): void;
  active(): LockRecord[];
}

export function createLockManager(
  db: StateDatabase,
  profileName: string,
  leaseMs: number,
): LockManager {
  return {
    acquire(issueNumber, owner) {
      return db.acquireLock(profileName, issueNumber, owner, leaseMs);
    },
    heartbeat(issueNumber, owner) {
      return db.heartbeatLock(profileName, issueNumber, owner, leaseMs);
    },
    release(issueNumber, owner) {
      db.releaseLock(profileName, issueNumber, owner);
    },
    active() {
      return db.getActiveLocks(profileName);
    },
  };
}
