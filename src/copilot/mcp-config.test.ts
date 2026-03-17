import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { _tmp } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");
  return { _tmp: mkdtempSync(join(tmpdir(), "max-mcp-test-")) };
});

vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => _tmp };
});

import { loadMcpConfig } from "./mcp-config.js";

describe("loadMcpConfig", () => {
  it("returns empty object when config file is missing", () => {
    expect(loadMcpConfig()).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const configDir = join(_tmp, ".copilot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp-config.json"), "not json{{{");
    expect(loadMcpConfig()).toEqual({});
  });

  it("returns empty object when mcpServers key is missing", () => {
    const configDir = join(_tmp, ".copilot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp-config.json"), JSON.stringify({ other: "stuff" }));
    expect(loadMcpConfig()).toEqual({});
  });

  it("returns mcpServers when config is valid", () => {
    const configDir = join(_tmp, ".copilot");
    mkdirSync(configDir, { recursive: true });
    const servers = {
      "my-server": { command: "node", args: ["server.js"] },
    };
    writeFileSync(join(configDir, "mcp-config.json"), JSON.stringify({ mcpServers: servers }));
    expect(loadMcpConfig()).toEqual(servers);
  });

  it("returns empty object when mcpServers is not an object", () => {
    const configDir = join(_tmp, ".copilot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp-config.json"), JSON.stringify({ mcpServers: "string" }));
    expect(loadMcpConfig()).toEqual({});
  });
});
