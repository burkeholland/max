import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { MCPServerConfig } from "@github/copilot-sdk";

const MCP_CONFIG_PATH = join(homedir(), ".copilot", "mcp-config.json");

/**
 * Load MCP server configs from ~/.copilot/mcp-config.json.
 * Returns an empty record if the file doesn't exist or is invalid.
 */
export function loadMcpConfig(): Record<string, MCPServerConfig> {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return parsed.mcpServers as Record<string, MCPServerConfig>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge a named MCP server entry into ~/.copilot/mcp-config.json.
 * Creates the file if it doesn't exist. Preserves all other servers.
 */
export function writeMcpServer(name: string, serverConfig: MCPServerConfig): void {
  let existing: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed;
      if (!existing.mcpServers || typeof existing.mcpServers !== "object" || Array.isArray(existing.mcpServers)) {
        existing.mcpServers = {};
      }
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
  }

  existing.mcpServers[name] = serverConfig;
  mkdirSync(dirname(MCP_CONFIG_PATH), { recursive: true });
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
}

/** Write the WorkIQ MCP server config, optionally scoped to a tenant. */
export function writeWorkIqConfig(tenantId?: string): void {
  const args = ["-y", "@microsoft/workiq@latest", "mcp"];
  if (tenantId) {
    args.push("--tenant-id", tenantId);
  }
  writeMcpServer("workiq", {
    command: "npx",
    args,
    tools: ["*"],
  } as MCPServerConfig);
}
