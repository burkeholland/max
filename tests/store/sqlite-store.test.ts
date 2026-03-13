import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { SQLiteStore } from "../../src/store/sqlite-store.js";

describe("SQLiteStore", () => {
  let store: SQLiteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "max-test-"));
    store = new SQLiteStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Key-value state
  // ------------------------------------------------------------------

  describe("state", () => {
    it("returns undefined for missing keys", () => {
      expect(store.getState("nope")).toBeUndefined();
    });

    it("sets and gets a value", () => {
      store.setState("key1", "value1");
      expect(store.getState("key1")).toBe("value1");
    });

    it("overwrites existing keys", () => {
      store.setState("key1", "a");
      store.setState("key1", "b");
      expect(store.getState("key1")).toBe("b");
    });

    it("deletes keys", () => {
      store.setState("key1", "a");
      store.deleteState("key1");
      expect(store.getState("key1")).toBeUndefined();
    });

    it("deleteState is a no-op for missing keys", () => {
      expect(() => store.deleteState("nope")).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // Conversation log
  // ------------------------------------------------------------------

  describe("conversationLog", () => {
    it("returns empty string when no conversations exist", () => {
      expect(store.getRecentConversation()).toBe("");
    });

    it("logs and retrieves conversations", () => {
      store.logConversation("user", "Hello", "telegram");
      store.logConversation("assistant", "Hi there!", "telegram");
      const recent = store.getRecentConversation(10);
      expect(recent).toContain("[telegram] User: Hello");
      expect(recent).toContain("Max: Hi there!");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.logConversation("user", `Message ${i}`, "tui");
      }
      const recent = store.getRecentConversation(3);
      expect(recent).toContain("Message 9");
      expect(recent).toContain("Message 8");
      expect(recent).toContain("Message 7");
      expect(recent).not.toContain("Message 0");
    });

    it("truncates long messages in output", () => {
      const longMsg = "x".repeat(600);
      store.logConversation("user", longMsg, "tui");
      const recent = store.getRecentConversation(1);
      expect(recent).toContain("…");
      expect(recent.length).toBeLessThan(600);
    });
  });

  // ------------------------------------------------------------------
  // Memory
  // ------------------------------------------------------------------

  describe("memory", () => {
    it("adds and searches memories", () => {
      const id = store.addMemory("fact", "TypeScript is great");
      expect(id).toBeGreaterThan(0);

      const results = store.searchMemories("TypeScript");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("TypeScript is great");
      expect(results[0].category).toBe("fact");
    });

    it("filters by category", () => {
      store.addMemory("preference", "Likes dark mode");
      store.addMemory("fact", "Lives in Portland");

      const prefs = store.searchMemories(undefined, "preference");
      expect(prefs).toHaveLength(1);
      expect(prefs[0].content).toBe("Likes dark mode");
    });

    it("filters by keyword", () => {
      store.addMemory("fact", "Uses VS Code");
      store.addMemory("fact", "Uses Vim");

      const results = store.searchMemories("Code");
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("VS Code");
    });

    it("preserves substring keyword matches via LIKE fallback", () => {
      store.addMemory("fact", "TypeScript is great");

      const results = store.searchMemories("Type");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("TypeScript is great");
    });

    it("keeps FTS index in sync for add/remove", () => {
      const id = store.addMemory("fact", "FTS sync check");

      const db = store.getRawDb();
      const indexed = db
        .prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`)
        .get("sync") as { rowid: number } | undefined;
      expect(indexed?.rowid).toBe(id);

      expect(store.removeMemory(id)).toBe(true);
      const afterDelete = db
        .prepare(`SELECT rowid FROM memories_fts WHERE rowid = ?`)
        .get(id);
      expect(afterDelete).toBeUndefined();
    });

    it("falls back to LIKE search when FTS table is unavailable", () => {
      store.addMemory("fact", "Fallback keyword");
      const db = store.getRawDb();
      db.exec("DROP TABLE memories_fts");

      const results = store.searchMemories("keyword");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Fallback keyword");
    });

    it("does not throw on add/remove when FTS table disappears", () => {
      const db = store.getRawDb();
      db.exec("DROP TABLE memories_fts");

      expect(() => store.addMemory("fact", "resilient write")).not.toThrow();
      const added = store.searchMemories("resilient");
      expect(added).toHaveLength(1);

      expect(() => store.removeMemory(added[0].id)).not.toThrow();
      expect(store.searchMemories("resilient")).toHaveLength(0);
    });

    it("bootstraps FTS for existing memories on open", () => {
      store.close();
      const dbPath = join(tmpDir, "migrate.db");
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      raw
        .prepare(`INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`)
        .run("fact", "legacy bootstrap memory", "user");
      raw.close();

      store = new SQLiteStore(dbPath);
      const results = store.searchMemories("legacy");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("legacy bootstrap memory");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.addMemory("fact", `Fact ${i}`);
      }
      const results = store.searchMemories(undefined, undefined, 3);
      expect(results).toHaveLength(3);
    });

    it("removes a memory", () => {
      const id = store.addMemory("fact", "Temporary fact");
      expect(store.removeMemory(id)).toBe(true);
      expect(store.searchMemories("Temporary")).toHaveLength(0);
    });

    it("removeMemory returns false for missing id", () => {
      expect(store.removeMemory(9999)).toBe(false);
    });

    it("generates memory summary grouped by category", () => {
      store.addMemory("preference", "Dark mode");
      store.addMemory("fact", "Portland");
      store.addMemory("preference", "TypeScript");

      const summary = store.getMemorySummary();
      expect(summary).toContain("**preference**");
      expect(summary).toContain("**fact**");
      expect(summary).toContain("Dark mode");
      expect(summary).toContain("Portland");
    });

    it("returns empty string when no memories exist", () => {
      expect(store.getMemorySummary()).toBe("");
    });
  });

  // ------------------------------------------------------------------
  // Worker sessions
  // ------------------------------------------------------------------

  describe("workerSessions", () => {
    it("saves, updates, and deletes worker sessions", () => {
      store.saveWorkerSession("test-worker", "session-123", "/tmp/test");
      store.updateWorkerStatus("test-worker", "running");

      const db = store.getRawDb();
      const row = db.prepare("SELECT status FROM worker_sessions WHERE name = ?").get("test-worker") as { status: string } | undefined;
      expect(row?.status).toBe("running");

      store.deleteWorkerSession("test-worker");
      const row2 = db.prepare("SELECT * FROM worker_sessions WHERE name = ?").get("test-worker");
      expect(row2).toBeUndefined();
    });
  });
});
