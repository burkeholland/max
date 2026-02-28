import * as readline from "readline";
import * as http from "http";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { HISTORY_PATH, ensureMaxHome } from "../paths.js";

const API_BASE = process.env.MAX_API_URL || "http://127.0.0.1:7777";

// ── ANSI helpers ──────────────────────────────────────────
const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  bgDim: (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
};

// ── Markdown → ANSI rendering ────────────────────────────
function renderMarkdown(text: string): string {
  // Handle code blocks first (before other formatting)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const label = lang ? C.dim(`  ${lang}`) + "\n" : "";
    const formatted = code
      .split("\n")
      .map((line: string) => `  ${C.dim(line)}`)
      .join("\n");
    return `${label}${formatted}`;
  });

  return text
    .split("\n")
    .map((line: string) => {
      // Headers
      if (line.startsWith("### ")) return C.boldCyan(line.slice(4));
      if (line.startsWith("## ")) return C.boldCyan(line.slice(3));
      if (line.startsWith("# ")) return C.boldCyan(line.slice(2));
      // Blockquotes
      if (line.startsWith("> ")) return `  ${C.dim(line.slice(2))}`;
      // List items
      if (/^[-*] /.test(line)) return `  • ${line.slice(2)}`;
      // Numbered lists
      if (/^\d+\. /.test(line)) return `  ${line}`;
      return line;
    })
    .join("\n")
    // Inline formatting (after line-level processing)
    .replace(/\*\*(.+?)\*\*/g, C.bold("$1"))
    .replace(/`([^`]+)`/g, C.yellow("$1"));
}

// ── State ─────────────────────────────────────────────────
let connectionId: string | undefined;
let isStreaming = false;
let streamedContent = "";

// ── Persistent history ────────────────────────────────────
const MAX_HISTORY = 1000;

function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_PATH)) {
      return readFileSync(HISTORY_PATH, "utf-8")
        .split("\n")
        .filter(Boolean)
        .slice(-MAX_HISTORY);
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistoryLine(line: string): void {
  try {
    appendFileSync(HISTORY_PATH, line + "\n");
  } catch { /* ignore */ }
}

function trimHistoryFile(): void {
  try {
    if (!existsSync(HISTORY_PATH)) return;
    const lines = readFileSync(HISTORY_PATH, "utf-8").split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY) {
      writeFileSync(HISTORY_PATH, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
  } catch { /* ignore */ }
}

// ── Readline setup ────────────────────────────────────────
ensureMaxHome();
const history = loadHistory();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${C.cyan("max")} ${C.dim(">")} `,
  history,
  historySize: MAX_HISTORY,
});

// ── Welcome banner ────────────────────────────────────────
function showBanner(): void {
  console.log();
  console.log(C.boldCyan("  ╔══════════════════════════════════╗"));
  console.log(C.boldCyan("  ║") + C.bold("     MAX") + C.dim("  — personal AI daemon") + C.boldCyan("    ║"));
  console.log(C.boldCyan("  ╚══════════════════════════════════╝"));
  console.log();
}

function showStatus(model?: string, skillCount?: number): void {
  const parts: string[] = [];
  if (model) parts.push(`${C.dim("model:")} ${C.cyan(model)}`);
  if (skillCount !== undefined) parts.push(`${C.dim("skills:")} ${C.cyan(String(skillCount))}`);
  if (parts.length) console.log(`  ${parts.join("   ")}`);
  console.log();
  console.log(C.dim("  Type a message, /help for commands, Esc to cancel"));
  console.log();
}

function fetchStartupInfo(): void {
  let model = "unknown";
  let skillCount = 0;
  let done = 0;
  const check = () => {
    done++;
    if (done === 2) showStatus(model, skillCount);
  };

  apiGetSilent("/model", (data: any) => { model = data?.model || "unknown"; check(); });
  apiGetSilent("/skills", (data: any) => { skillCount = Array.isArray(data) ? data.length : 0; check(); });
}

// ── SSE connection ────────────────────────────────────────
function connectSSE(): void {
  const url = new URL("/stream", API_BASE);

  http.get(url, (res) => {
    console.log(C.green("  ✓ Connected to Max daemon"));
    fetchStartupInfo();
    let buffer = "";

    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "connected") {
              connectionId = event.connectionId;
            } else if (event.type === "delta") {
              if (!isStreaming) {
                isStreaming = true;
                streamedContent = "";
                process.stdout.write("\n");
              }
              // Content is cumulative — only print the new part
              const full = event.content || "";
              const newText = full.slice(streamedContent.length);
              if (newText) {
                process.stdout.write(newText);
                streamedContent = full;
              }
            } else if (event.type === "cancelled") {
              isStreaming = false;
              streamedContent = "";
            } else if (event.type === "message") {
              if (isStreaming) {
                // Streaming is done — just add spacing and re-prompt
                isStreaming = false;
                streamedContent = "";
                process.stdout.write("\n\n");
              } else {
                // Proactive/background message — render with markdown
                console.log(`\n${renderMarkdown(event.content)}\n`);
              }
              rl.prompt();
            }
          } catch {
            // Malformed event, ignore
          }
        }
      }
    });

    res.on("end", () => {
      console.log(C.yellow("\n  ⚠ Disconnected from Max daemon. Reconnecting..."));
      isStreaming = false;
      setTimeout(connectSSE, 2000);
    });

    res.on("error", (err) => {
      console.error(C.red(`\n  ✗ Connection error: ${err.message}. Retrying...`));
      isStreaming = false;
      setTimeout(connectSSE, 3000);
    });
  }).on("error", (err) => {
    console.error(C.red(`  ✗ Cannot connect to Max daemon at ${API_BASE}: ${err.message}`));
    console.error(C.dim("    Is the daemon running? Start it with: max start"));
    setTimeout(connectSSE, 5000);
  });
}

// ── API helpers ───────────────────────────────────────────
function sendMessage(prompt: string): void {
  const body = JSON.stringify({ prompt, connectionId });
  const url = new URL("/message", API_BASE);

  const req = http.request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(C.red(`  Error: ${data}`));
          rl.prompt();
        }
      });
    }
  );

  req.on("error", (err) => {
    console.error(C.red(`  Failed to send: ${err.message}`));
    rl.prompt();
  });

  req.write(body);
  req.end();
}

/** Silent GET — no re-prompt (used for startup info) */
function apiGetSilent(path: string, cb: (data: any) => void): void {
  const url = new URL(path, API_BASE);
  http.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { /* ignore */ }
    });
  }).on("error", () => { cb(null); });
}

/** GET a JSON endpoint and call back with parsed result. */
function apiGet(path: string, cb: (data: any) => void): void {
  const url = new URL(path, API_BASE);
  http.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { console.log(data); }
      rl.prompt();
    });
  }).on("error", (err) => {
    console.error(C.red(`  Error: ${err.message}`));
    rl.prompt();
  });
}

/** POST a JSON endpoint and call back with parsed result. */
function apiPost(path: string, body: Record<string, unknown>, cb: (data: any) => void): void {
  const json = JSON.stringify(body);
  const url = new URL(path, API_BASE);
  const req = http.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try { cb(JSON.parse(data)); } catch { console.log(data); }
      rl.prompt();
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Error: ${err.message}`));
    rl.prompt();
  });
  req.write(json);
  req.end();
}

function sendCancel(): void {
  const url = new URL("/cancel", API_BASE);
  const req = http.request(url, { method: "POST" }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (isStreaming) process.stdout.write("\n");
      isStreaming = false;
      streamedContent = "";
      console.log(C.red("  ⛔ Cancelled.\n"));
      rl.prompt();
    });
  });
  req.on("error", (err) => {
    console.error(C.red(`  Failed to cancel: ${err.message}`));
    rl.prompt();
  });
  req.end();
}

// ── Command handlers ──────────────────────────────────────
function cmdWorkers(): void {
  apiGet("/sessions", (sessions: any[]) => {
    if (!sessions || sessions.length === 0) {
      console.log(C.dim("  No active worker sessions.\n"));
    } else {
      for (const s of sessions) {
        const badge = s.status === "idle" ? C.green("● idle") : C.yellow("● busy");
        console.log(`  ${badge}  ${C.bold(s.name)}  ${C.dim(s.workingDir)}`);
      }
      console.log();
    }
  });
}

function cmdModel(arg: string): void {
  if (arg) {
    apiPost("/model", { model: arg }, (data: any) => {
      if (data.error) {
        console.log(C.red(`  Error: ${data.error}\n`));
      } else {
        console.log(`  ${C.dim("model:")} ${C.dim(data.previous)} → ${C.cyan(data.current)}\n`);
      }
    });
  } else {
    apiGet("/model", (data: any) => {
      console.log(`  ${C.dim("model:")} ${C.cyan(data.model)}\n`);
    });
  }
}

function cmdMemory(): void {
  apiGet("/memory", (memories: any[]) => {
    if (!memories || memories.length === 0) {
      console.log(C.dim("  No memories stored.\n"));
    } else {
      for (const m of memories) {
        const cat = C.magenta(`[${m.category}]`);
        console.log(`  ${C.dim(`#${m.id}`)} ${cat} ${m.content}`);
      }
      console.log(C.dim(`\n  ${memories.length} memories total.\n`));
    }
  });
}

function cmdSkills(): void {
  apiGet("/skills", (skills: any[]) => {
    if (!skills || skills.length === 0) {
      console.log(C.dim("  No skills installed.\n"));
    } else {
      for (const s of skills) {
        const src = s.source === "bundled" ? C.dim("bundled")
          : s.source === "local" ? C.green("local")
          : C.cyan("global");
        console.log(`  • ${C.bold(s.name)} ${C.dim(`(${src})`)} ${C.dim("—")} ${s.description}`);
      }
      console.log();
    }
  });
}

function cmdHelp(): void {
  console.log();
  console.log(C.bold("  Commands"));
  console.log(`  ${C.cyan("/cancel")}              Cancel the current message`);
  console.log(`  ${C.cyan("/model")}               Show current model`);
  console.log(`  ${C.cyan("/model")} ${C.dim("<name>")}       Switch model`);
  console.log(`  ${C.cyan("/memory")}              Show stored memories`);
  console.log(`  ${C.cyan("/skills")}              List installed skills`);
  console.log(`  ${C.cyan("/workers")}             List active worker sessions`);
  console.log(`  ${C.cyan("/restart")}             Restart Max daemon`);
  console.log(`  ${C.cyan("/status")}              Daemon health check`);
  console.log(`  ${C.cyan("/clear")}               Clear the screen`);
  console.log(`  ${C.cyan("/quit")}                Exit the TUI`);
  console.log();
  console.log(C.dim("  Press Escape to cancel a running message"));
  console.log(C.dim("  Anything else is sent to Max"));
  console.log();
}

// ── Main ──────────────────────────────────────────────────
showBanner();
console.log(C.dim("  Connecting to Max daemon..."));
connectSSE();

// Wait a moment for SSE connection before showing prompt
setTimeout(() => {
  rl.prompt();

  // Listen for Escape key to cancel in-flight messages
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string, key: readline.Key) => {
      if (key && key.name === "escape") {
        sendCancel();
      }
    });
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Save to persistent history (skip commands)
    if (!trimmed.startsWith("/")) {
      saveHistoryLine(trimmed);
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      trimHistoryFile();
      console.log(C.dim("  Bye."));
      process.exit(0);
    }

    if (trimmed === "/cancel") { sendCancel(); return; }
    if (trimmed === "/sessions" || trimmed === "/workers") { cmdWorkers(); return; }
    if (trimmed.startsWith("/model")) { cmdModel(trimmed.slice(6).trim()); return; }
    if (trimmed === "/memory") { cmdMemory(); return; }
    if (trimmed === "/skills") { cmdSkills(); return; }
    if (trimmed === "/help") { cmdHelp(); return; }

    if (trimmed === "/status") {
      apiGet("/status", (data: any) => {
        console.log(JSON.stringify(data, null, 2) + "\n");
      });
      return;
    }

    if (trimmed === "/restart") {
      apiPost("/restart", {}, () => {
        console.log(C.yellow("  ⏳ Max is restarting...\n"));
      });
      return;
    }

    if (trimmed === "/clear") {
      console.clear();
      rl.prompt();
      return;
    }

    // Send to orchestrator
    sendMessage(trimmed);
  });

  rl.on("close", () => {
    trimHistoryFile();
    console.log(C.dim("\n  Bye."));
    process.exit(0);
  });
}, 1000);
