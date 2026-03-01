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
  coral: (s: string) => `\x1b[38;2;255;127;80m${s}\x1b[0m`,
  boldWhite: (s: string) => `\x1b[1;97m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;2;14;165;233m${s}\x1b[0m`,
};

// ── Layout constants ─────────────────────────────────────
const LABEL_PAD = "          "; // 10-char indent for continuation lines

// ── Markdown → ANSI rendering ────────────────────────────

/** Render a single line of markdown to ANSI (used by both streaming and batch). */
function renderLine(line: string, inCodeBlock: boolean): string {
  if (inCodeBlock) {
    return `  ${C.dim("│")} ${line}`;
  }
  if (/^[-*_]{3,}\s*$/.test(line)) return C.dim("──────────────────────────────────");
  if (line.startsWith("### ")) return C.coral(line.slice(4));
  if (line.startsWith("## ")) return C.boldWhite(line.slice(3));
  if (line.startsWith("# ")) return C.boldWhite(line.slice(2));
  if (line.startsWith("> ")) return `${C.dim("│")} ${C.dim(line.slice(2))}`;
  if (/^ {2,}[-*] /.test(line)) return `    ◦ ${line.replace(/^ +[-*] /, "")}`;
  if (/^[-*] /.test(line)) return `  • ${line.slice(2)}`;
  if (/^\d+\. /.test(line)) return `  ${line}`;
  return line;
}

/** Apply inline formatting (bold, code, links, etc.) to already-rendered text. */
function applyInlineFormatting(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, `\x1b[1;3m$1\x1b[0m`)
    .replace(/\*\*(.+?)\*\*/g, `\x1b[1m$1\x1b[0m`)
    .replace(/~~(.+?)~~/g, `\x1b[9m$1\x1b[0m`)
    .replace(/`([^`]+)`/g, C.yellow("$1"))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `${t} ${C.dim(`(${u})`)}`);
}

/** Render a complete markdown document to ANSI (used for proactive/background messages). */
function renderMarkdown(text: string): string {
  let inCodeBlock = false;
  const rendered = text.split("\n").map((line: string) => {
    if (/^```/.test(line)) {
      if (inCodeBlock) { inCodeBlock = false; return ""; }
      inCodeBlock = true;
      const lang = line.slice(3).trim();
      return lang ? C.dim(lang) : "";
    }
    return renderLine(line, inCodeBlock);
  });
  return applyInlineFormatting(rendered.join("\n"));
}

/** Write a rendered message with a role label (MAX/SYS). */
function writeLabeled(role: "max" | "sys", text: string): void {
  const label = role === "max"
    ? `  ${C.cyan("MAX")}     `
    : `  ${C.dim("SYS")}     `;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write((i === 0 ? label : LABEL_PAD) + lines[i] + "\n");
  }
}

// ── Streaming markdown renderer ──────────────────────────
let streamLineBuffer = "";
let inStreamCodeBlock = false;
let streamIsFirstLine = true;

/** Get the prefix for the current stream line (label or padding). */
function streamPrefix(): string {
  return streamIsFirstLine ? `  ${C.cyan("MAX")}     ` : LABEL_PAD;
}

/** Clear the current visual line (handles terminal wrapping). */
function clearVisualLine(charCount: number): void {
  const cols = process.stdout.columns || 80;
  const up = Math.ceil(Math.max(charCount, 1) / cols) - 1;
  if (up > 0) process.stdout.write(`\x1b[${up}A`);
  process.stdout.write(`\r\x1b[J`);
}

/** Render a buffered line and write it with the appropriate prefix. */
function writeRenderedStreamLine(line: string): void {
  const prefix = streamPrefix();
  if (/^```/.test(line)) {
    if (inStreamCodeBlock) {
      inStreamCodeBlock = false;
    } else {
      inStreamCodeBlock = true;
      const lang = line.slice(3).trim();
      process.stdout.write(prefix + (lang ? C.dim(lang) : ""));
    }
  } else {
    const rendered = applyInlineFormatting(renderLine(line, inStreamCodeBlock));
    process.stdout.write(prefix + rendered);
  }
  process.stdout.write("\n");
  streamIsFirstLine = false;
}

/** Process a chunk of streaming text, rendering complete lines with labels. */
function writeStreamChunk(newText: string): void {
  let pos = 0;
  while (pos < newText.length) {
    const nl = newText.indexOf("\n", pos);

    if (nl === -1) {
      // No newline — buffer and write raw with prefix if at line start
      const partial = newText.slice(pos);
      if (streamLineBuffer.length === 0) {
        process.stdout.write(streamPrefix());
      }
      streamLineBuffer += partial;
      process.stdout.write(partial);
      return;
    }

    // Got a complete line
    const segment = newText.slice(pos, nl);
    const hadPartial = streamLineBuffer.length > 0;
    streamLineBuffer += segment;

    if (hadPartial) {
      // Clear the partially-written raw text
      clearVisualLine(10 + streamLineBuffer.length);
    }

    if (streamLineBuffer.length === 0 && !hadPartial) {
      // Empty line
      process.stdout.write(streamPrefix() + "\n");
      streamIsFirstLine = false;
    } else {
      writeRenderedStreamLine(streamLineBuffer);
    }

    streamLineBuffer = "";
    pos = nl + 1;
  }
}

/** Flush any remaining partial line and reset streaming state. */
function flushStreamState(): void {
  if (streamLineBuffer.length > 0) {
    clearVisualLine(10 + streamLineBuffer.length);
    writeRenderedStreamLine(streamLineBuffer);
  }
  streamLineBuffer = "";
  inStreamCodeBlock = false;
  streamIsFirstLine = true;
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
  prompt: `  ${C.coral("›")} `,
  history,
  historySize: MAX_HISTORY,
});

// ── Welcome banner ────────────────────────────────────────
function showBanner(): void {
  console.clear();
  console.log();
  console.log();
  console.log(C.boldWhite("    ██      ██     █████     ██   ██"));
  console.log(C.boldWhite("    ███    ███    ██   ██     ██ ██"));
  console.log(C.boldWhite("    ██ ████ ██    ███████      ███"));
  console.log(C.boldWhite("    ██  ██  ██    ██   ██     ██ ██"));
  console.log(C.boldWhite("    ██      ██    ██   ██    ██   ██") + "  " + C.coral("●"));
  console.log();
  console.log(C.dim("    personal AI assistant for developers"));
  console.log();
}

function showStatus(model?: string, skillCount?: number): void {
  const parts: string[] = [];
  if (model) parts.push(`${C.dim("model:")} ${C.cyan(model)}`);
  if (skillCount !== undefined) parts.push(`${C.dim("skills:")} ${C.cyan(String(skillCount))}`);
  if (parts.length) console.log(`    ${parts.join("    ")}`);
  console.log();
  console.log(C.dim("    /help for commands · esc to cancel"));
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
    console.log(C.green("  ● ") + C.dim("max — connected"));
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
                streamLineBuffer = "";
                inStreamCodeBlock = false;
                streamIsFirstLine = true;
                process.stdout.write("\n");
              }
              // Content is cumulative — only print the new part
              const full = event.content || "";
              const newText = full.slice(streamedContent.length);
              if (newText) {
                writeStreamChunk(newText);
                streamedContent = full;
              }
            } else if (event.type === "cancelled") {
              isStreaming = false;
              streamedContent = "";
              streamLineBuffer = "";
              inStreamCodeBlock = false;
              streamIsFirstLine = true;
            } else if (event.type === "message") {
              if (isStreaming) {
                // Streaming is done — flush remaining and re-prompt
                flushStreamState();
                isStreaming = false;
                streamedContent = "";
                process.stdout.write("\n\n");
              } else {
                // Proactive/background message — render with label
                const rendered = renderMarkdown(event.content);
                process.stdout.write("\n");
                writeLabeled("max", rendered);
                process.stdout.write("\n");
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
      console.log(C.yellow("\n    ⚠ disconnected — reconnecting..."));
      isStreaming = false;
      setTimeout(connectSSE, 2000);
    });

    res.on("error", (err) => {
      console.error(C.red(`\n    ✗ connection error — retrying...`));
      isStreaming = false;
      setTimeout(connectSSE, 3000);
    });
  }).on("error", (err) => {
    console.error(C.red(`    ✗ cannot connect to daemon`));
    console.error(C.dim("      start with: max start"));
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
      console.log(C.dim("    ⛔ cancelled\n"));
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
  console.log(C.boldWhite("    COMMANDS"));
  console.log();
  console.log(`    ${C.coral("/model")} ${C.dim("[name]")}        show or switch model`);
  console.log(`    ${C.coral("/memory")}               show stored memories`);
  console.log(`    ${C.coral("/skills")}               list installed skills`);
  console.log(`    ${C.coral("/workers")}              list active sessions`);
  console.log(`    ${C.coral("/status")}               daemon health check`);
  console.log(`    ${C.coral("/restart")}              restart daemon`);
  console.log(`    ${C.coral("/copy")}                copy last response`);
  console.log(`    ${C.coral("/clear")}                clear screen`);
  console.log(`    ${C.coral("/quit")}                 exit`);
  console.log();
  console.log(C.dim("    press escape to cancel a running response"));
  console.log();
}

// ── Main ──────────────────────────────────────────────────
showBanner();
console.log(C.dim("    connecting..."));
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

      // Re-echo user input with YOU label, accounting for terminal wrapping
      const cols = process.stdout.columns || 80;
      const promptVisualLen = 4; // "  › " is 4 visible chars
      const inputVisualLen = promptVisualLen + trimmed.length;
      const wrappedLines = Math.ceil(Math.max(inputVisualLen, 1) / cols);
      // Move up enough lines to cover all wrapped lines
      if (wrappedLines > 1) {
        process.stdout.write(`\x1b[${wrappedLines}A\r\x1b[J`);
      } else {
        process.stdout.write(`\x1b[1A\r\x1b[J`);
      }

      // Print with YOU label, wrapping long text with LABEL_PAD
      const label = `  ${C.coral("YOU")}     `;
      const contentWidth = cols - 10; // 10 = label visual width
      if (contentWidth > 0 && trimmed.length > contentWidth) {
        const lines: string[] = [];
        for (let i = 0; i < trimmed.length; i += contentWidth) {
          lines.push(trimmed.slice(i, i + contentWidth));
        }
        for (let i = 0; i < lines.length; i++) {
          console.log((i === 0 ? label : LABEL_PAD) + lines[i]);
        }
      } else {
        console.log(label + trimmed);
      }
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      trimHistoryFile();
      console.log(C.dim("\n    bye.\n"));
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

    if (trimmed === "/copy") {
      if (!streamedContent) {
        console.log(C.dim("  No response to copy.\n"));
        rl.prompt();
        return;
      }
      const { exec } = require("child_process");
      const escaped = streamedContent.replace(/'/g, "'\\''");
      exec(`printf '%s' '${escaped}' | xclip -selection clipboard 2>/dev/null || printf '%s' '${escaped}' | xsel --clipboard --input 2>/dev/null || printf '%s' '${escaped}' | pbcopy 2>/dev/null`, (err: Error | null) => {
        if (err) {
          console.log(C.dim("  Clipboard tool not found (install xclip or xsel).\n"));
        } else {
          console.log(C.dim("  ✓ Copied to clipboard.\n"));
        }
        rl.prompt();
      });
      return;
    }

    // Send to orchestrator
    sendMessage(trimmed);
  });

  rl.on("close", () => {
    trimHistoryFile();
    console.log(C.dim("\n    bye.\n"));
    process.exit(0);
  });
}, 1000);
