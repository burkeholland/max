import { describe, it, expect } from "vitest";
import { getOrchestratorSystemMessage } from "./system-message.js";

describe("getOrchestratorSystemMessage", () => {
  it("returns a non-empty system message", () => {
    const msg = getOrchestratorSystemMessage();
    expect(msg).toBeTruthy();
    expect(msg).toContain("You are Max");
  });

  it("includes memory summary when provided", () => {
    const msg = getOrchestratorSystemMessage("User prefers dark mode");
    expect(msg).toContain("Long-Term Memory");
    expect(msg).toContain("User prefers dark mode");
  });

  it("omits memory section when no summary provided", () => {
    const msg = getOrchestratorSystemMessage();
    expect(msg).not.toContain("Long-Term Memory");
  });

  it("omits memory section for empty string", () => {
    const msg = getOrchestratorSystemMessage("");
    expect(msg).not.toContain("Long-Term Memory");
  });

  it("includes self-edit protection by default", () => {
    const msg = getOrchestratorSystemMessage();
    expect(msg).toContain("Self-Edit Protection");
    expect(msg).toContain("NEVER modify your own source code");
  });

  it("excludes self-edit protection when selfEditEnabled is true", () => {
    const msg = getOrchestratorSystemMessage(undefined, { selfEditEnabled: true });
    expect(msg).not.toContain("Self-Edit Protection");
  });

  it("includes self-edit protection when selfEditEnabled is false", () => {
    const msg = getOrchestratorSystemMessage(undefined, { selfEditEnabled: false });
    expect(msg).toContain("Self-Edit Protection");
  });

  it("includes both memory and self-edit protection together", () => {
    const msg = getOrchestratorSystemMessage("Remember: likes TypeScript", { selfEditEnabled: false });
    expect(msg).toContain("Long-Term Memory");
    expect(msg).toContain("likes TypeScript");
    expect(msg).toContain("Self-Edit Protection");
  });

  it("describes key capabilities", () => {
    const msg = getOrchestratorSystemMessage();
    expect(msg).toContain("Telegram");
    expect(msg).toContain("Worker");
    expect(msg).toContain("Skills");
    expect(msg).toContain("Memory");
  });
});
