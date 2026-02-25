import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { MCPServerConfig } from "@github/copilot-sdk";

/**
 * Load MCP server configs from ~/.copilot/mcp-config.json.
 * Returns an empty record if the file doesn't exist or is invalid.
 */
export function loadMcpConfig(): Record<string, MCPServerConfig> {
  const configPath = join(homedir(), ".copilot", "mcp-config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return parsed.mcpServers as Record<string, MCPServerConfig>;
    }
    return {};
  } catch {
    return {};
  }
}
