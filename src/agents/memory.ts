// ---------------------------------------------------------------------------
// Namespace-scoped memory — wraps db.ts memory functions with namespace
// ---------------------------------------------------------------------------

import { getDb, addMemory, searchMemories, removeMemory, getRelevantMemories } from "../store/db.js";

/**
 * Add a memory to a specific agent's namespace.
 * Falls back to "global" (Max's namespace) when no namespace specified.
 */
export function addAgentMemory(
  namespace: string,
  category: "preference" | "fact" | "project" | "person" | "routine",
  content: string,
  source: "user" | "auto" = "user"
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO memories (category, content, source, namespace) VALUES (?, ?, ?, ?)`
  ).run(category, content, source, namespace);
  return result.lastInsertRowid as number;
}

/**
 * Search memories within a specific namespace.
 * Optionally include the "global" namespace for shared context.
 */
export function searchAgentMemories(
  namespace: string,
  keyword?: string,
  category?: string,
  limit = 20,
  includeGlobal = false,
): { id: number; category: string; content: string; source: string; namespace: string; created_at: string }[] {
  const db = getDb();
  const namespaces = includeGlobal && namespace !== "global"
    ? [namespace, "global"]
    : [namespace];
  const nsPlaceholders = namespaces.map(() => "?").join(",");

  const conditions: string[] = [`namespace IN (${nsPlaceholders})`];
  const params: (string | number)[] = [...namespaces];

  if (keyword) {
    const escapedKeyword = keyword.replace(/[%_\\]/g, "\\$&");
    conditions.push(`content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapedKeyword}%`);
  }
  if (category) {
    conditions.push(`category = ?`);
    params.push(category);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  params.push(limit);

  return db.prepare(
    `SELECT id, category, content, source, namespace, created_at FROM memories ${where} ORDER BY last_accessed DESC LIMIT ?`
  ).all(...params) as { id: number; category: string; content: string; source: string; namespace: string; created_at: string }[];
}

/**
 * Get relevant memories for a query, scoped to a namespace.
 */
export function getAgentRelevantMemories(namespace: string, query: string, limit = 5): string[] {
  const db = getDb();
  const cleanQuery = query.replace(/^\[via (?:telegram|tui)\]\s*/i, "").trim();
  const queryWords = new Set(
    cleanQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );

  if (queryWords.size === 0) {
    const rows = db.prepare(
      `SELECT content FROM memories WHERE namespace = ? ORDER BY last_accessed DESC LIMIT ?`
    ).all(namespace, Math.min(limit, 3)) as { content: string }[];
    return rows.map((r) => r.content);
  }

  // Word overlap search within namespace
  const rows = db.prepare(
    `SELECT id, content FROM memories WHERE namespace = ? ORDER BY last_accessed DESC`
  ).all(namespace) as { id: number; content: string }[];

  const scored = rows.map((row) => {
    const memWords = row.content.toLowerCase().split(/\s+/);
    let hits = 0;
    for (const w of memWords) {
      if (queryWords.has(w)) hits++;
    }
    return { ...row, hits };
  }).filter((r) => r.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);

  if (scored.length === 0) {
    const recent = db.prepare(
      `SELECT content FROM memories WHERE namespace = ? ORDER BY last_accessed DESC LIMIT ?`
    ).all(namespace, Math.min(limit, 3)) as { content: string }[];
    return recent.map((r) => r.content);
  }

  if (scored.length > 0) {
    const placeholders = scored.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...scored.map((r) => r.id));
  }

  return scored.map((r) => r.content);
}

/**
 * Get a compact memory summary for an agent's namespace.
 */
export function getAgentMemorySummary(namespace: string): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, category, content FROM memories WHERE namespace = ? ORDER BY category, last_accessed DESC`
  ).all(namespace) as { id: number; category: string; content: string }[];

  if (rows.length === 0) return "";

  const grouped: Record<string, { id: number; content: string }[]> = {};
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push({ id: r.id, content: r.content });
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const lines = items.map((i) => `  - [#${i.id}] ${i.content}`).join("\n");
    return `**${cat}**:\n${lines}`;
  });

  return sections.join("\n");
}

/**
 * Count memories in a namespace.
 */
export function countAgentMemories(namespace: string): number {
  const db = getDb();
  return (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE namespace = ?`).get(namespace) as { c: number }).c;
}
