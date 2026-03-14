import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getDb,
  closeDb,
  getState,
  setState,
  deleteState,
  logConversation,
  getRecentConversation,
  addMemory,
  searchMemories,
  removeMemory,
  getMemorySummary,
} from "./db.js";

// Use in-memory SQLite for each test
beforeEach(() => {
  closeDb();
  getDb(":memory:");
});

afterEach(() => {
  closeDb();
});

describe("state management", () => {
  it("returns undefined for missing key", () => {
    expect(getState("missing")).toBeUndefined();
  });

  it("sets and gets a value", () => {
    setState("foo", "bar");
    expect(getState("foo")).toBe("bar");
  });

  it("overwrites existing value", () => {
    setState("key", "v1");
    setState("key", "v2");
    expect(getState("key")).toBe("v2");
  });

  it("deletes a key", () => {
    setState("key", "val");
    deleteState("key");
    expect(getState("key")).toBeUndefined();
  });

  it("delete on missing key is a no-op", () => {
    expect(() => deleteState("nope")).not.toThrow();
  });
});

describe("conversation log", () => {
  it("logs and retrieves a conversation turn", () => {
    logConversation("user", "Hello", "telegram");
    logConversation("assistant", "Hi there!", "telegram");

    const history = getRecentConversation(10);
    expect(history).toContain("User");
    expect(history).toContain("Hello");
    expect(history).toContain("Max");
    expect(history).toContain("Hi there!");
  });

  it("returns empty string when no conversations exist", () => {
    expect(getRecentConversation()).toBe("");
  });

  it("limits results to the requested count", () => {
    for (let i = 0; i < 30; i++) {
      logConversation("user", `msg-${i}`, "tui");
    }
    const history = getRecentConversation(5);
    // Should only contain the last 5 messages
    expect(history).toContain("msg-29");
    expect(history).toContain("msg-25");
    expect(history).not.toContain("msg-0");
  });

  it("returns history in chronological order", () => {
    logConversation("user", "first", "tui");
    logConversation("assistant", "second", "tui");
    logConversation("user", "third", "tui");

    const history = getRecentConversation(10);
    const firstIdx = history.indexOf("first");
    const secondIdx = history.indexOf("second");
    const thirdIdx = history.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("truncates long messages in history output", () => {
    const longMsg = "x".repeat(1000);
    logConversation("user", longMsg, "tui");
    const history = getRecentConversation(10);
    expect(history).toContain("…");
    expect(history.length).toBeLessThan(1000);
  });

  it("logs system role messages", () => {
    logConversation("system", "background task done", "background");
    const history = getRecentConversation(10);
    expect(history).toContain("System");
    expect(history).toContain("background task done");
  });

  it("caps conversation log at 200 entries", () => {
    for (let i = 0; i < 210; i++) {
      logConversation("user", `msg-${i}`, "tui");
    }
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as c FROM conversation_log").get() as { c: number };
    expect(count.c).toBe(200);
  });
});

describe("memories", () => {
  it("adds and searches a memory", () => {
    const id = addMemory("fact", "User uses VS Code");
    expect(id).toBeGreaterThan(0);

    const results = searchMemories("VS Code");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("User uses VS Code");
    expect(results[0].category).toBe("fact");
  });

  it("searches by category", () => {
    addMemory("preference", "prefers dark mode");
    addMemory("fact", "works at GitHub");

    const prefs = searchMemories(undefined, "preference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0].content).toContain("dark mode");
  });

  it("searches by keyword and category together", () => {
    addMemory("preference", "likes TypeScript");
    addMemory("preference", "likes coffee");
    addMemory("fact", "knows TypeScript");

    const results = searchMemories("TypeScript", "preference");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("likes TypeScript");
  });

  it("returns all memories when no filters given", () => {
    addMemory("fact", "one");
    addMemory("preference", "two");
    addMemory("project", "three");

    const results = searchMemories();
    expect(results).toHaveLength(3);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      addMemory("fact", `fact-${i}`);
    }
    const results = searchMemories(undefined, undefined, 3);
    expect(results).toHaveLength(3);
  });

  it("removes a memory by ID", () => {
    const id = addMemory("fact", "to be deleted");
    expect(removeMemory(id)).toBe(true);
    expect(searchMemories("to be deleted")).toHaveLength(0);
  });

  it("returns false when removing nonexistent memory", () => {
    expect(removeMemory(999)).toBe(false);
  });

  it("generates a memory summary grouped by category", () => {
    addMemory("preference", "dark mode");
    addMemory("fact", "uses Mac");
    addMemory("preference", "vim keybindings");

    const summary = getMemorySummary();
    expect(summary).toContain("**preference**");
    expect(summary).toContain("**fact**");
    expect(summary).toContain("dark mode");
    expect(summary).toContain("uses Mac");
    expect(summary).toContain("vim keybindings");
  });

  it("returns empty string for no memories", () => {
    expect(getMemorySummary()).toBe("");
  });

  it("stores auto-sourced memories", () => {
    addMemory("routine", "standup at 9am", "auto");
    const results = searchMemories("standup");
    expect(results[0].source).toBe("auto");
  });
});
