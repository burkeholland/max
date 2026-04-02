import Database from "better-sqlite3";
import { DB_PATH, ensureMaxHome } from "../paths.js";

export type MemoryCategory = "preference" | "fact" | "project" | "person" | "routine" | "task" | "decision" | "context";

let db: Database.Database | undefined;
let logInsertCount = 0;
let fts5Available = false;

export function getDb(): Database.Database {
  if (!db) {
    ensureMaxHome();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS max_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine', 'task', 'decision', 'context')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        importance INTEGER NOT NULL DEFAULT 3,
        context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate memories: expand CHECK constraint and add new columns
    try {
      db.prepare(`INSERT INTO memories (category, content, source) VALUES ('task', '__migration_test__', 'user')`).run();
      db.prepare(`DELETE FROM memories WHERE content = '__migration_test__'`).run();
      // CHECK is good — ensure new columns exist (safe if already present)
      for (const col of [
        `ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3`,
        `ALTER TABLE memories ADD COLUMN context TEXT`,
        `ALTER TABLE memories ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
      ]) {
        try { db.exec(col); } catch { /* column already exists */ }
      }
    } catch {
      // CHECK constraint doesn't allow new categories — recreate table in a transaction
      db.exec(`BEGIN`);
      try {
        db.exec(`ALTER TABLE memories RENAME TO memories_old`);
        db.exec(`
          CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine', 'task', 'decision', 'context')),
            content TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'user',
            importance INTEGER NOT NULL DEFAULT 3,
            context TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`INSERT INTO memories (id, category, content, source, created_at, last_accessed) SELECT id, category, content, source, created_at, last_accessed FROM memories_old`);
        db.exec(`DROP TABLE memories_old`);
        db.exec(`COMMIT`);
      } catch (migErr) {
        db.exec(`ROLLBACK`);
        throw migErr;
      }
    }
    // Conversation summaries — rolling segment summaries that survive session restarts
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        first_turn_ts DATETIME,
        last_turn_ts DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate: if the table already existed with a stricter CHECK, recreate it
    try {
      db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`).run();
      db.prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`).run();
    } catch {
      // CHECK constraint doesn't allow 'system' — recreate table preserving data
      db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
      db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`);
      db.exec(`DROP TABLE conversation_log_old`);
    }
    // Prune conversation log at startup — keep more history for better recovery
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();

    // Set up FTS5 for memory search (graceful fallback if not available)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content_rowid='id'
        )
      `);
      // Sync triggers
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      // Backfill: check if FTS is in sync by comparing row counts
      const memCount = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memories_fts`).get() as { c: number }).c;
      if (memCount > 0 && ftsCount < memCount) {
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
      }
      fts5Available = true;
    } catch {
      // FTS5 not available in this SQLite build — fall back to LIKE queries
      fts5Available = false;
    }
  }
  return db;
}

export function getState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM max_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO max_state (key, value) VALUES (?, ?)`).run(key, value);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM max_state WHERE key = ?`).run(key);
}

/** Log a conversation turn (user, assistant, or system). */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES (?, ?, ?)`).run(role, content, source);
  // Keep last 1000 entries to support context recovery after session loss
  logInsertCount++;
  if (logInsertCount % 50 === 0) {
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();
  }
}

/** Get recent conversation history formatted for injection into system message. */
export function getRecentConversation(limit = 20): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { role: string; content: string; source: string; ts: string }[];

  if (rows.length === 0) return "";

  // Reverse so oldest is first (chronological order)
  rows.reverse();

  return rows.map((r) => {
    const tag = r.role === "user" ? `[${r.source}] User`
      : r.role === "system" ? `[${r.source}] System`
      : "Max";
    // Truncate long messages to keep context manageable
    const content = r.content.length > 1500 ? r.content.slice(0, 1500) + "…" : r.content;
    return `${tag}: ${content}`;
  }).join("\n\n");
}

/** Add a memory to long-term storage. */
export function addMemory(
  category: MemoryCategory,
  content: string,
  source: "user" | "auto" = "user",
  importance = 3,
  context?: string
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO memories (category, content, source, importance, context) VALUES (?, ?, ?, ?, ?)`
  ).run(category, content, source, Math.max(1, Math.min(5, importance)), context ?? null);
  return result.lastInsertRowid as number;
}

/** Search memories by keyword and/or category. Uses FTS5 when available. */
export function searchMemories(
  keyword?: string,
  category?: string,
  limit = 20
): { id: number; category: string; content: string; source: string; created_at: string }[] {
  const db = getDb();

  // FTS5 path: better ranking and matching
  if (keyword && fts5Available) {
    try {
      // Sanitize FTS5 query: wrap each word in quotes to avoid syntax errors
      const ftsQuery = keyword.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
      const categoryFilter = category ? `AND m.category = ?` : "";
      const params: (string | number)[] = [ftsQuery];
      if (category) params.push(category);
      params.push(limit);

      const rows = db.prepare(`
        SELECT m.id, m.category, m.content, m.source, m.created_at
        FROM memories_fts f
        JOIN memories m ON m.id = f.rowid
        WHERE memories_fts MATCH ? ${categoryFilter}
        ORDER BY bm25(memories_fts) LIMIT ?
      `).all(...params) as { id: number; category: string; content: string; source: string; created_at: string }[];

      if (rows.length > 0) {
        const placeholders = rows.map(() => "?").join(",");
        db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...rows.map((r) => r.id));
      }
      return rows;
    } catch {
      // FTS5 query failed — fall through to LIKE
    }
  }

  // LIKE fallback
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (keyword) {
    const escapedKeyword = keyword.replace(/[%_\\]/g, "\\$&");
    conditions.push(`content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapedKeyword}%`);
  }
  if (category) {
    conditions.push(`category = ?`);
    params.push(category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = db.prepare(
    `SELECT id, category, content, source, created_at FROM memories ${where} ORDER BY last_accessed DESC LIMIT ?`
  ).all(...params) as { id: number; category: string; content: string; source: string; created_at: string }[];

  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...rows.map((r) => r.id));
  }

  return rows;
}

/** Remove a memory by ID. */
export function removeMemory(id: number): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** Get a compact summary of all memories for injection into system message. */
export function getMemorySummary(): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, category, content, importance FROM memories ORDER BY category, importance DESC, last_accessed DESC`
  ).all() as { id: number; category: string; content: string; importance: number }[];

  if (rows.length === 0) return "";

  // Group by category
  const grouped: Record<string, { id: number; content: string; importance: number }[]> = {};
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push({ id: r.id, content: r.content, importance: r.importance });
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const lines = items.map((i) => {
      const stars = i.importance >= 4 ? " ★" : "";
      return `  - [#${i.id}] ${i.content}${stars}`;
    }).join("\n");
    return `**${cat}**:\n${lines}`;
  });

  return sections.join("\n");
}

/** Check if a similar memory already exists (≥70% word overlap). */
export function findSimilarMemory(content: string): boolean {
  const db = getDb();
  const words = new Set(content.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (words.size === 0) return false;

  const rows = db.prepare(
    `SELECT content FROM memories`
  ).all() as { content: string }[];

  for (const row of rows) {
    const existingWords = new Set(row.content.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (existingWords.size === 0) continue;
    let overlap = 0;
    for (const w of words) {
      if (existingWords.has(w)) overlap++;
    }
    const similarity = overlap / Math.max(words.size, existingWords.size);
    if (similarity >= 0.7) return true;
  }
  return false;
}

/** Search memories for content relevant to a query. Uses FTS5 when available, falls back to word overlap. */
export function getRelevantMemories(query: string, limit = 10): string[] {
  const db = getDb();

  // Strip channel tags for cleaner matching
  const cleanQuery = query.replace(/^\[via (?:telegram|tui)\]\s*/i, "").trim();
  const queryWords = new Set(
    cleanQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );

  // Always include high-importance memories (★ importance >= 5)
  const critical = db.prepare(
    `SELECT id, content FROM memories WHERE importance >= 5 ORDER BY last_accessed DESC LIMIT 5`
  ).all() as { id: number; content: string }[];
  const criticalContents = critical.map((r) => r.content);
  const criticalIds = new Set(critical.map((r) => r.id));
  const remaining = Math.max(0, limit - criticalContents.length);

  if (queryWords.size === 0) {
    const rows = db.prepare(
      `SELECT content FROM memories ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(Math.min(limit, 5)) as { content: string }[];
    return rows.map((r) => r.content);
  }

  // Try FTS5 first
  if (fts5Available && remaining > 0) {
    try {
      const ftsQuery = [...queryWords].map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT m.id, m.content, m.importance
        FROM memories_fts f
        JOIN memories m ON m.id = f.rowid
        WHERE memories_fts MATCH ?
        ORDER BY m.importance DESC, bm25(memories_fts) LIMIT ?
      `).all(ftsQuery, remaining + 5) as { id: number; content: string; importance: number }[];

      const filtered = rows.filter((r) => !criticalIds.has(r.id)).slice(0, remaining);
      if (filtered.length > 0) {
        const allIds = [...critical, ...filtered].map((r) => r.id);
        const placeholders = allIds.map(() => "?").join(",");
        db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...allIds);
        return [...criticalContents, ...filtered.map((r) => r.content)];
      }
    } catch { /* fall through to word overlap */ }
  }

  // Word overlap fallback with importance weighting
  const rows = db.prepare(
    `SELECT id, content, importance FROM memories ORDER BY last_accessed DESC`
  ).all() as { id: number; content: string; importance: number }[];

  const scored = rows
    .filter((r) => !criticalIds.has(r.id))
    .map((row) => {
      const memWords = row.content.toLowerCase().split(/\s+/);
      let hits = 0;
      for (const w of memWords) {
        if (queryWords.has(w)) hits++;
      }
      // Weight by importance: importance 5 = 2x boost, importance 1 = 0.5x
      const importanceWeight = 0.5 + (row.importance / 5);
      return { ...row, score: hits * importanceWeight };
    })
    .filter((r) => r.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, remaining);

  if (scored.length === 0 && criticalContents.length === 0) {
    const recent = db.prepare(
      `SELECT content FROM memories ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(Math.min(limit, 5)) as { content: string }[];
    return recent.map((r) => r.content);
  }

  const allIds = [...critical, ...scored].map((r) => r.id);
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...allIds);
  }

  return [...criticalContents, ...scored.map((r) => r.content)];
}

const AUTO_MEMORY_CAP = 500;
const STALE_DAYS = 90;

/** Remove near-duplicate memories (≥70% word overlap), keeping the newer one. */
export function deduplicateMemories(): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, content FROM memories ORDER BY id ASC`
  ).all() as { id: number; content: string }[];

  const toDelete: number[] = [];
  const seen: { id: number; words: Set<string> }[] = [];

  for (const row of rows) {
    const words = new Set(row.content.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (words.size === 0) continue;

    let isDup = false;
    for (const prev of seen) {
      let overlap = 0;
      for (const w of words) {
        if (prev.words.has(w)) overlap++;
      }
      const similarity = overlap / Math.max(words.size, prev.words.size);
      if (similarity >= 0.7) {
        // Keep the newer one (higher id), delete the older
        toDelete.push(prev.id);
        prev.id = row.id;
        prev.words = words;
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      seen.push({ id: row.id, words });
    }
  }

  if (toDelete.length > 0) {
    const placeholders = toDelete.map(() => "?").join(",");
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...toDelete);
  }
  return toDelete.length;
}

/** Remove auto-generated memories not accessed in the given number of days. */
export function pruneStaleMemories(maxAgeDays = STALE_DAYS): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM memories WHERE source = 'auto' AND last_accessed < datetime('now', '-' || ? || ' days')`
  ).run(maxAgeDays);
  return result.changes;
}

/** Cap auto-generated memories at a maximum count, evicting least-recently-accessed first. */
export function capAutoMemories(maxCount = AUTO_MEMORY_CAP): number {
  const db = getDb();
  const count = (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE source = 'auto'`).get() as { c: number }).c;
  if (count <= maxCount) return 0;

  const excess = count - maxCount;
  const result = db.prepare(
    `DELETE FROM memories WHERE source = 'auto' AND id IN (
      SELECT id FROM memories WHERE source = 'auto' ORDER BY last_accessed ASC LIMIT ?
    )`
  ).run(excess);
  return result.changes;
}

/** Update an existing memory's content, importance, or context. */
export function updateMemory(id: number, updates: { content?: string; importance?: number; context?: string }): boolean {
  const db = getDb();
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (updates.content !== undefined) {
    sets.push(`content = ?`);
    params.push(updates.content);
  }
  if (updates.importance !== undefined) {
    sets.push(`importance = ?`);
    params.push(Math.max(1, Math.min(5, updates.importance)));
  }
  if (updates.context !== undefined) {
    sets.push(`context = ?`);
    params.push(updates.context);
  }

  if (sets.length === 0) return false;
  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(id);

  const result = db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

/** Get top memories by importance, optionally filtered by minimum importance. */
export function getTopMemories(limit = 20, minImportance = 1): { id: number; category: string; content: string; importance: number }[] {
  const db = getDb();
  return db.prepare(
    `SELECT id, category, content, importance FROM memories WHERE importance >= ? ORDER BY importance DESC, last_accessed DESC LIMIT ?`
  ).all(minImportance, limit) as { id: number; category: string; content: string; importance: number }[];
}

/** Store a conversation summary. */
export function addSummary(summary: string, turnCount: number, firstTurnTs?: string, lastTurnTs?: string): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO conversation_summaries (summary, turn_count, first_turn_ts, last_turn_ts) VALUES (?, ?, ?, ?)`
  ).run(summary, turnCount, firstTurnTs ?? null, lastTurnTs ?? null);
  // Keep at most 50 summaries
  db.prepare(`DELETE FROM conversation_summaries WHERE id NOT IN (SELECT id FROM conversation_summaries ORDER BY id DESC LIMIT 50)`).run();
  return result.lastInsertRowid as number;
}

/** Get recent conversation summaries for session recovery. */
export function getRecentSummaries(limit = 5): { id: number; summary: string; turn_count: number; created_at: string }[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, summary, turn_count, created_at FROM conversation_summaries ORDER BY id DESC LIMIT ?`
  ).all(limit) as { id: number; summary: string; turn_count: number; created_at: string }[];
  rows.reverse(); // chronological order
  return rows;
}

/** Get conversation turns since a given log ID for summarization. Uses monotonic id to avoid timestamp-precision skips. */
export function getConversationSince(sinceId?: number, limit = 30): { id: number; role: string; content: string; source: string; ts: string }[] {
  const db = getDb();
  if (sinceId) {
    return db.prepare(
      `SELECT id, role, content, source, ts FROM conversation_log WHERE id > ? ORDER BY id ASC LIMIT ?`
    ).all(sinceId, limit) as { id: number; role: string; content: string; source: string; ts: string }[];
  }
  const rows = db.prepare(
    `SELECT id, role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { id: number; role: string; content: string; source: string; ts: string }[];
  rows.reverse();
  return rows;
}

/** Run all memory maintenance tasks. Returns summary of actions taken. */
export function runMemoryMaintenance(): { deduped: number; pruned: number; capped: number } {
  const deduped = deduplicateMemories();
  const pruned = pruneStaleMemories();
  const capped = capAutoMemories();
  return { deduped, pruned, capped };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
