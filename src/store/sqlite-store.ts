import Database from "better-sqlite3";
import type {
  Store,
  MemoryCategory,
  ConversationRole,
  MemorySource,
  MemoryRecord,
} from "../types/store.js";

/**
 * SQLite-backed implementation of the Store interface.
 *
 * All methods are synchronous (better-sqlite3 is sync) but satisfy the
 * Store interface which is intentionally sync to keep the call-sites simple.
 */
export class SQLiteStore implements Store {
  private db: Database.Database;
  private logInsertCount = 0;
  private hasFts5 = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
  }

  /** Expose the raw database for advanced / migration use. */
  getRawDb(): Database.Database {
    return this.db;
  }

  // ------------------------------------------------------------------
  // Table setup
  // ------------------------------------------------------------------

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS max_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.initMemoriesFts();

    // Migrate: if the table already existed with a stricter CHECK, recreate it
    try {
      this.db
        .prepare(
          `INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`,
        )
        .run();
      this.db
        .prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`)
        .run();
    } catch {
      this.db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
      this.db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        `INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`,
      );
      this.db.exec(`DROP TABLE conversation_log_old`);
    }

    // Prune conversation log at startup
    this.db
      .prepare(
        `DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`,
      )
      .run();
  }

  // ------------------------------------------------------------------
  // Key-value state
  // ------------------------------------------------------------------

  getState(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM max_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO max_state (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare(`DELETE FROM max_state WHERE key = ?`).run(key);
  }

  // ------------------------------------------------------------------
  // Conversation log
  // ------------------------------------------------------------------

  logConversation(
    role: ConversationRole,
    content: string,
    source: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO conversation_log (role, content, source) VALUES (?, ?, ?)`,
      )
      .run(role, content, source);

    this.logInsertCount++;
    if (this.logInsertCount % 50 === 0) {
      this.db
        .prepare(
          `DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 200)`,
        )
        .run();
    }
  }

  getRecentConversation(limit = 20): string {
    const rows = this.db
      .prepare(
        `SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      role: string;
      content: string;
      source: string;
      ts: string;
    }[];

    if (rows.length === 0) return "";

    rows.reverse();

    return rows
      .map((r) => {
        const tag =
          r.role === "user"
            ? `[${r.source}] User`
            : r.role === "system"
              ? `[${r.source}] System`
              : "Max";
        const content =
          r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
        return `${tag}: ${content}`;
      })
      .join("\n\n");
  }

  // ------------------------------------------------------------------
  // Long-term memory
  // ------------------------------------------------------------------

  private initMemoriesFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(
          content,
          category UNINDEXED,
          content='memories',
          content_rowid='id'
        )
      `);
      this.db
        .prepare(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`)
        .run();
      this.hasFts5 = true;
    } catch {
      this.hasFts5 = false;
    }
  }

  addMemory(
    category: MemoryCategory,
    content: string,
    source: MemorySource = "user",
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`,
      )
      .run(category, content, source);
    const id = result.lastInsertRowid as number;

    if (this.hasFts5) {
      try {
        this.db
          .prepare(
            `INSERT INTO memories_fts (rowid, content, category) VALUES (?, ?, ?)`,
          )
          .run(id, content, category);
      } catch {
        this.hasFts5 = false;
      }
    }

    return id;
  }

  searchMemories(
    keyword?: string,
    category?: string,
    limit = 20,
  ): MemoryRecord[] {
    let rows: MemoryRecord[] = [];

    if (keyword && this.hasFts5) {
      try {
        const params: (string | number)[] = [keyword];
        const categoryClause = category ? `AND m.category = ?` : "";
        if (category) params.push(category);
        params.push(limit);

        rows = this.db
          .prepare(
            `SELECT m.id, m.category, m.content, m.source, m.created_at
             FROM memories_fts f
             JOIN memories m ON m.id = f.rowid
             WHERE memories_fts MATCH ? ${categoryClause}
             ORDER BY bm25(memories_fts), m.last_accessed DESC
             LIMIT ?`,
          )
          .all(...params) as MemoryRecord[];
        if (rows.length === 0) {
          rows = this.searchMemoriesLike(keyword, category, limit);
        }
      } catch {
        this.hasFts5 = false;
        rows = this.searchMemoriesLike(keyword, category, limit);
      }
    } else if (keyword) {
      rows = this.searchMemoriesLike(keyword, category, limit);
    } else {
      const params: (string | number)[] = [];
      const categoryClause = category ? `WHERE category = ?` : "";
      if (category) params.push(category);
      params.push(limit);
      rows = this.db
        .prepare(
          `SELECT id, category, content, source, created_at
           FROM memories
           ${categoryClause}
           ORDER BY last_accessed DESC
           LIMIT ?`,
        )
        .all(...params) as MemoryRecord[];
    }

    if (rows.length > 0) {
      const placeholders = rows.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        )
        .run(...rows.map((r) => r.id));
    }

    return rows;
  }

  private searchMemoriesLike(
    keyword: string,
    category?: string,
    limit = 20,
  ): MemoryRecord[] {
    const conditions: string[] = [`content LIKE ?`];
    const params: (string | number)[] = [`%${keyword}%`];
    if (category) {
      conditions.push(`category = ?`);
      params.push(category);
    }
    params.push(limit);

    return this.db
      .prepare(
        `SELECT id, category, content, source, created_at
         FROM memories
         WHERE ${conditions.join(" AND ")}
         ORDER BY last_accessed DESC
         LIMIT ?`,
      )
      .all(...params) as MemoryRecord[];
  }

  removeMemory(id: number): boolean {
    const result = this.db
      .prepare(`DELETE FROM memories WHERE id = ?`)
      .run(id);
    if (result.changes > 0 && this.hasFts5) {
      try {
        this.db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(id);
      } catch {
        this.hasFts5 = false;
      }
    }
    return result.changes > 0;
  }

  getMemorySummary(): string {
    const rows = this.db
      .prepare(
        `SELECT id, category, content FROM memories ORDER BY category, last_accessed DESC`,
      )
      .all() as { id: number; category: string; content: string }[];

    if (rows.length === 0) return "";

    const grouped: Record<string, { id: number; content: string }[]> = {};
    for (const r of rows) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push({ id: r.id, content: r.content });
    }

    const sections = Object.entries(grouped).map(([cat, items]) => {
      const lines = items
        .map((i) => `  - [#${i.id}] ${i.content}`)
        .join("\n");
      return `**${cat}**:\n${lines}`;
    });

    return sections.join("\n");
  }

  // ------------------------------------------------------------------
  // Worker session persistence
  // ------------------------------------------------------------------

  saveWorkerSession(
    name: string,
    sessionId: string,
    workingDir: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status) VALUES (?, ?, ?, 'idle')`,
      )
      .run(name, sessionId, workingDir);
  }

  updateWorkerStatus(name: string, status: string): void {
    this.db
      .prepare(
        `UPDATE worker_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      )
      .run(status, name);
  }

  deleteWorkerSession(name: string): void {
    this.db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(name);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
