import Database from "better-sqlite3";
import { dirname } from "node:path";

import type {
  GitHubIssue,
  IssueEdge,
  LockRecord,
  PullRequestRecord,
  RunPhase,
  RunRecord,
  RunStatus,
  WorktreeRecord,
} from "./types.js";
import { ensureDir, nowIso } from "./utils.js";

interface IssueRow {
  profile_name: string;
  issue_number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels_json: string;
  assignees_json: string;
  author: string | null;
  updated_at: string;
  url: string;
  is_epic: number;
  is_meta: number;
  priority: number;
  raw_json: string | null;
}

interface EdgeRow {
  profile_name: string;
  from_issue: number;
  to_issue: number;
  edge_type: IssueEdge["type"];
  blocking: number;
  confidence: number;
  source: IssueEdge["source"];
  note: string | null;
}

interface LockRow {
  profile_name: string;
  issue_number: number;
  owner: string;
  lease_expires_at: string;
  heartbeat_at: string;
  created_at: string;
}

interface RunRow {
  run_id: string;
  profile_name: string;
  issue_number: number;
  phase: RunPhase;
  status: RunStatus;
  dry_run: number;
  branch_name: string | null;
  worktree_path: string | null;
  started_at: string;
  ended_at: string | null;
  metadata_json: string | null;
}

interface WorktreeRow {
  profile_name: string;
  issue_number: number;
  branch_name: string;
  path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PullRequestRow {
  profile_name: string;
  issue_number: number;
  run_id: string;
  pr_number: number;
  url: string;
  branch_name: string;
  status: string;
  merge_state: string | null;
  created_at: string;
  updated_at: string;
}

export class StateDatabase {
  readonly db: Database.Database;

  constructor(public readonly dbPath: string) {
    ensureDir(dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS issues (
        profile_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        assignees_json TEXT NOT NULL,
        author TEXT,
        updated_at TEXT NOT NULL,
        url TEXT NOT NULL,
        is_epic INTEGER NOT NULL DEFAULT 0,
        is_meta INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT,
        PRIMARY KEY (profile_name, issue_number)
      );

      CREATE TABLE IF NOT EXISTS issue_edges (
        profile_name TEXT NOT NULL,
        from_issue INTEGER NOT NULL,
        to_issue INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        blocking INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (profile_name, from_issue, to_issue, edge_type, source)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS locks (
        profile_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_name, issue_number)
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        profile_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch_name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_name, issue_number)
      );

      CREATE TABLE IF NOT EXISTS prs (
        profile_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        url TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        status TEXT NOT NULL,
        merge_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_name, pr_number)
      );

      CREATE TABLE IF NOT EXISTS comments_reviews (
        profile_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        external_id TEXT NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_name, pr_number, external_id)
      );

      INSERT OR IGNORE INTO schema_version(version) VALUES (1);
    `);
  }

  upsertIssues(profileName: string, issues: GitHubIssue[]): void {
    const insert = this.db.prepare(`
      INSERT INTO issues (
        profile_name, issue_number, title, body, state, labels_json, assignees_json,
        author, updated_at, url, is_epic, is_meta, priority, raw_json
      ) VALUES (
        @profile_name, @issue_number, @title, @body, @state, @labels_json, @assignees_json,
        @author, @updated_at, @url, @is_epic, @is_meta, @priority, @raw_json
      )
      ON CONFLICT(profile_name, issue_number) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        state = excluded.state,
        labels_json = excluded.labels_json,
        assignees_json = excluded.assignees_json,
        author = excluded.author,
        updated_at = excluded.updated_at,
        url = excluded.url,
        is_epic = excluded.is_epic,
        is_meta = excluded.is_meta,
        priority = excluded.priority,
        raw_json = excluded.raw_json
    `);

    const tx = this.db.transaction((openIssues: GitHubIssue[]) => {
      for (const issue of openIssues) {
        insert.run({
          profile_name: profileName,
          issue_number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels_json: JSON.stringify(issue.labels),
          assignees_json: JSON.stringify(issue.assignees),
          author: issue.author ?? null,
          updated_at: issue.updatedAt,
          url: issue.url,
          is_epic: issue.isEpic ? 1 : 0,
          is_meta: issue.isMeta ? 1 : 0,
          priority: issue.priority,
          raw_json: issue.raw ? JSON.stringify(issue.raw) : null,
        });
      }

      if (openIssues.length === 0) {
        this.db
          .prepare(`UPDATE issues SET state = 'CLOSED' WHERE profile_name = ?`)
          .run(profileName);
        return;
      }

      const placeholders = openIssues.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE issues
             SET state = 'CLOSED'
           WHERE profile_name = ?
             AND issue_number NOT IN (${placeholders})`,
        )
        .run(profileName, ...openIssues.map((issue) => issue.number));
    });

    tx(issues);
  }

  getIssues(profileName: string, state?: "OPEN" | "CLOSED"): GitHubIssue[] {
    const rows = (
      state
        ? this.db
            .prepare(
              `SELECT * FROM issues WHERE profile_name = ? AND state = ? ORDER BY issue_number ASC`,
            )
            .all(profileName, state)
        : this.db
            .prepare(`SELECT * FROM issues WHERE profile_name = ? ORDER BY issue_number ASC`)
            .all(profileName)
    ) as IssueRow[];

    return rows.map((row) => mapIssue(row));
  }

  getIssue(profileName: string, issueNumber: number): GitHubIssue | undefined {
    const row = this.db
      .prepare(`SELECT * FROM issues WHERE profile_name = ? AND issue_number = ?`)
      .get(profileName, issueNumber) as IssueRow | undefined;
    return row ? mapIssue(row) : undefined;
  }

  replaceIssueEdges(profileName: string, edges: IssueEdge[]): void {
    const insert = this.db.prepare(`
      INSERT INTO issue_edges (
        profile_name, from_issue, to_issue, edge_type, blocking, confidence, source, note
      ) VALUES (
        @profile_name, @from_issue, @to_issue, @edge_type, @blocking, @confidence, @source, @note
      )
    `);

    const tx = this.db.transaction((records: IssueEdge[]) => {
      this.db.prepare(`DELETE FROM issue_edges WHERE profile_name = ?`).run(profileName);
      for (const edge of records) {
        insert.run({
          profile_name: profileName,
          from_issue: edge.fromIssue,
          to_issue: edge.toIssue,
          edge_type: edge.type,
          blocking: edge.blocking ? 1 : 0,
          confidence: edge.confidence,
          source: edge.source,
          note: edge.note ?? null,
        });
      }
    });

    tx(edges);
  }

  getIssueEdges(profileName: string): IssueEdge[] {
    const rows = this.db
      .prepare(`SELECT * FROM issue_edges WHERE profile_name = ? ORDER BY from_issue, to_issue`)
      .all(profileName) as EdgeRow[];
    return rows.map(mapEdge);
  }

  acquireLock(
    profileName: string,
    issueNumber: number,
    owner: string,
    leaseMs: number,
    now = nowIso(),
  ): boolean {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM locks WHERE profile_name = ? AND issue_number = ?`,
        )
        .get(profileName, issueNumber) as LockRow | undefined;

      if (existing && new Date(existing.lease_expires_at).getTime() > new Date(now).getTime()) {
        return false;
      }

      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
      this.db
        .prepare(`
          INSERT INTO locks (
            profile_name, issue_number, owner, lease_expires_at, heartbeat_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_name, issue_number) DO UPDATE SET
            owner = excluded.owner,
            lease_expires_at = excluded.lease_expires_at,
            heartbeat_at = excluded.heartbeat_at
        `)
        .run(profileName, issueNumber, owner, leaseExpiresAt, now, existing?.created_at ?? now);

      return true;
    });

    return tx();
  }

  heartbeatLock(
    profileName: string,
    issueNumber: number,
    owner: string,
    leaseMs: number,
    now = nowIso(),
  ): boolean {
    const lock = this.db
      .prepare(
        `SELECT * FROM locks WHERE profile_name = ? AND issue_number = ? AND owner = ?`,
      )
      .get(profileName, issueNumber, owner) as LockRow | undefined;

    if (!lock) {
      return false;
    }

    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
    this.db
      .prepare(
        `UPDATE locks
            SET heartbeat_at = ?, lease_expires_at = ?
          WHERE profile_name = ? AND issue_number = ? AND owner = ?`,
      )
      .run(now, leaseExpiresAt, profileName, issueNumber, owner);

    return true;
  }

  releaseLock(profileName: string, issueNumber: number, owner?: string): void {
    if (owner) {
      this.db
        .prepare(
          `DELETE FROM locks WHERE profile_name = ? AND issue_number = ? AND owner = ?`,
        )
        .run(profileName, issueNumber, owner);
      return;
    }

    this.db
      .prepare(`DELETE FROM locks WHERE profile_name = ? AND issue_number = ?`)
      .run(profileName, issueNumber);
  }

  getActiveLocks(profileName: string, now = nowIso()): LockRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM locks WHERE profile_name = ? AND lease_expires_at > ? ORDER BY issue_number ASC`,
      )
      .all(profileName, now) as LockRow[];
    return rows.map(mapLock);
  }

  insertRun(record: RunRecord): void {
    this.db
      .prepare(`
        INSERT INTO runs (
          run_id, profile_name, issue_number, phase, status, dry_run, branch_name,
          worktree_path, started_at, ended_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.runId,
        record.profileName,
        record.issueNumber,
        record.phase,
        record.status,
        record.dryRun ? 1 : 0,
        record.branchName ?? null,
        record.worktreePath ?? null,
        record.startedAt,
        record.endedAt ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      );
  }

  updateRun(runId: string, fields: Partial<RunRecord>): void {
    const current = this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    const next: RunRecord = {
      ...current,
      ...fields,
      metadata:
        current.metadata || fields.metadata
          ? {
              ...(current.metadata ?? {}),
              ...(fields.metadata ?? {}),
            }
          : undefined,
    };

    this.db
      .prepare(`
        UPDATE runs SET
          phase = ?,
          status = ?,
          dry_run = ?,
          branch_name = ?,
          worktree_path = ?,
          started_at = ?,
          ended_at = ?,
          metadata_json = ?
        WHERE run_id = ?
      `)
      .run(
        next.phase,
        next.status,
        next.dryRun ? 1 : 0,
        next.branchName ?? null,
        next.worktreePath ?? null,
        next.startedAt,
        next.endedAt ?? null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        runId,
      );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  getActiveRuns(profileName: string): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE profile_name = ?
            AND status IN ('queued', 'running')
          ORDER BY started_at ASC`,
      )
      .all(profileName) as RunRow[];
    return rows.map(mapRun);
  }

  getIssueRuns(profileName: string, issueNumber: number): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE profile_name = ?
            AND issue_number = ?
          ORDER BY started_at DESC`,
      )
      .all(profileName, issueNumber) as RunRow[];
    return rows.map(mapRun);
  }

  upsertWorktree(record: WorktreeRecord): void {
    this.db
      .prepare(`
        INSERT INTO worktrees (
          profile_name, issue_number, branch_name, path, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_name, issue_number) DO UPDATE SET
          branch_name = excluded.branch_name,
          path = excluded.path,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(
        record.profileName,
        record.issueNumber,
        record.branchName,
        record.path,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
  }

  getWorktree(profileName: string, issueNumber: number): WorktreeRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM worktrees WHERE profile_name = ? AND issue_number = ?`)
      .get(profileName, issueNumber) as WorktreeRow | undefined;
    return row ? mapWorktree(row) : undefined;
  }

  upsertPr(record: PullRequestRecord): void {
    this.db
      .prepare(`
        INSERT INTO prs (
          profile_name, issue_number, run_id, pr_number, url, branch_name, status, merge_state,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_name, pr_number) DO UPDATE SET
          issue_number = excluded.issue_number,
          run_id = excluded.run_id,
          url = excluded.url,
          branch_name = excluded.branch_name,
          status = excluded.status,
          merge_state = excluded.merge_state,
          updated_at = excluded.updated_at
      `)
      .run(
        record.profileName,
        record.issueNumber,
        record.runId,
        record.prNumber,
        record.url,
        record.branchName,
        record.status,
        record.mergeState ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  listOpenPrs(profileName: string): PullRequestRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM prs WHERE profile_name = ? AND status IN ('OPEN', 'DRAFT') ORDER BY pr_number ASC`,
      )
      .all(profileName) as PullRequestRow[];
    return rows.map(mapPr);
  }

  replaceCommentReviews(
    profileName: string,
    prNumber: number,
    items: Array<{
      externalId: string;
      author: string;
      kind: string;
      state: string;
      body: string;
      createdAt: string;
      updatedAt: string;
    }>,
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM comments_reviews WHERE profile_name = ? AND pr_number = ?`)
        .run(profileName, prNumber);

      const insert = this.db.prepare(`
        INSERT INTO comments_reviews (
          profile_name, pr_number, external_id, author, kind, state, body, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insert.run(
          profileName,
          prNumber,
          item.externalId,
          item.author,
          item.kind,
          item.state,
          item.body,
          item.createdAt,
          item.updatedAt,
        );
      }
    });

    tx();
  }
}

function mapIssue(row: IssueRow): GitHubIssue {
  return {
    profileName: row.profile_name,
    number: row.issue_number,
    title: row.title,
    body: row.body,
    state: row.state,
    labels: JSON.parse(row.labels_json) as string[],
    assignees: JSON.parse(row.assignees_json) as string[],
    author: row.author ?? undefined,
    updatedAt: row.updated_at,
    url: row.url,
    isEpic: Boolean(row.is_epic),
    isMeta: Boolean(row.is_meta),
    priority: row.priority,
    raw: row.raw_json ? (JSON.parse(row.raw_json) as unknown) : undefined,
  };
}

function mapEdge(row: EdgeRow): IssueEdge {
  return {
    profileName: row.profile_name,
    fromIssue: row.from_issue,
    toIssue: row.to_issue,
    type: row.edge_type,
    blocking: Boolean(row.blocking),
    confidence: row.confidence,
    source: row.source,
    note: row.note ?? undefined,
  };
}

function mapLock(row: LockRow): LockRecord {
  return {
    profileName: row.profile_name,
    issueNumber: row.issue_number,
    owner: row.owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    profileName: row.profile_name,
    issueNumber: row.issue_number,
    phase: row.phase,
    status: row.status,
    dryRun: Boolean(row.dry_run),
    branchName: row.branch_name ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

function mapWorktree(row: WorktreeRow): WorktreeRecord {
  return {
    profileName: row.profile_name,
    issueNumber: row.issue_number,
    branchName: row.branch_name,
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPr(row: PullRequestRow): PullRequestRecord {
  return {
    profileName: row.profile_name,
    issueNumber: row.issue_number,
    runId: row.run_id,
    prNumber: row.pr_number,
    url: row.url,
    branchName: row.branch_name,
    status: row.status,
    mergeState: row.merge_state ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
