import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools, fetchReadableContent, truncateSafely } from "../../src/copilot/tools.js";
import type { ToolDeps } from "../../src/copilot/tools.js";
import type { AppConfig } from "../../src/types/config.js";
import type { Store } from "../../src/types/store.js";
import type { ModelProvider } from "../../src/types/provider.js";
import type { SkillProvider } from "../../src/types/skill.js";

function makeDeps(): ToolDeps {
  const provider = {} as ModelProvider;
  const store = {} as Store;
  const skills = {} as SkillProvider;
  const config: AppConfig = {
    telegramBotToken: undefined,
    authorizedUserId: undefined,
    apiPort: 7777,
    workerTimeoutMs: 30_000,
    telegramEnabled: false,
    selfEditEnabled: false,
    copilotModel: "gpt-4.1",
  };

  return {
    provider,
    store,
    config,
    skills,
    persistModel: () => {},
    workers: new Map(),
    onWorkerComplete: () => {},
    getCurrentSourceChannel: () => "tui",
  };
}

describe("fetch_url helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("truncateSafely truncates by code points", () => {
    const result = truncateSafely("ab😀cd", 4);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("ab😀c");
  });

  it("fetchReadableContent extracts readable text and truncates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<html><head><title>Hello</title></head><body><article><h1>Hello</h1><p>One two three four five six.</p></article></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );

    const result = await fetchReadableContent("https://93.184.216.34/post", 10);
    expect(result.title).toContain("Hello");
    expect(result.content).toContain("[truncated to 10 characters]");
    expect(result.truncated).toBe(true);
  });

  it("blocks localhost targets", async () => {
    await expect(fetchReadableContent("http://localhost:3000/test")).rejects.toThrow(
      "localhost is not allowed",
    );
  });

  it("blocks IPv6-mapped loopback targets", async () => {
    await expect(fetchReadableContent("http://[::ffff:127.0.0.1]/test")).rejects.toThrow(
      "private or loopback IP is not allowed",
    );
  });

  it("blocks redirects to localhost", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 302, headers: { location: "http://localhost:3000/private" } }),
    );
    await expect(fetchReadableContent("https://93.184.216.34/start")).rejects.toThrow(
      "localhost is not allowed",
    );
  });
});

describe("fetch_url tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns explicit failure message when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const tools = createTools(makeDeps());
    const fetchUrlTool = tools.find((tool) => tool.name === "fetch_url");
    expect(fetchUrlTool).toBeDefined();

    const output = await fetchUrlTool!.handler({ url: "https://93.184.216.34" });
    expect(String(output)).toContain("fetch_url failed:");
    expect(String(output)).toContain("network down");
  });
});
