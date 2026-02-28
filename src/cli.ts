#!/usr/bin/env node

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  const version = getVersion();
  console.log(`
max v${version} — AI orchestrator powered by Copilot SDK

Usage:
  max <command>

Commands:
  start       Start the Max daemon (Telegram bot + HTTP API)
  tui         Connect to the daemon via terminal UI
  setup       Interactive first-run configuration
  help        Show this help message

Examples:
  max start   Start the daemon
  max tui     Open the terminal client
  max setup   Configure Telegram token and settings
`.trim());
}

const args = process.argv.slice(2);
const command = args[0] || "help";

switch (command) {
  case "start":
    await import("./daemon.js");
    break;
  case "tui":
    await import("./tui/index.js");
    break;
  case "setup":
    await import("./setup.js");
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  case "--version":
  case "-v":
    console.log(getVersion());
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
