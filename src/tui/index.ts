import * as readline from "readline";
import * as http from "http";

const API_BASE = process.env.MAX_API_URL || "http://127.0.0.1:7777";

let connectionId: string | undefined;

function connectSSE(): void {
  const url = new URL("/stream", API_BASE);

  http.get(url, (res) => {
    console.log("Connected to Max daemon\n");
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
              // Show a spinner while streaming (don't try to render partial content)
              process.stdout.write(`\r\x1b[K⏳ Max is thinking...`);
            } else if (event.type === "cancelled") {
              // Server confirmed cancellation — handled by sendCancel()
            } else if (event.type === "message") {
              // Final message — clear spinner and print
              process.stdout.write(`\r\x1b[K`);
              console.log(`\n${event.content}\n`);
              rl.prompt();
            }
          } catch {
            // Malformed event, ignore
          }
        }
      }
    });

    res.on("end", () => {
      console.log("\nDisconnected from Max daemon. Reconnecting...");
      setTimeout(connectSSE, 2000);
    });

    res.on("error", (err) => {
      console.error(`\nConnection error: ${err.message}. Retrying...`);
      setTimeout(connectSSE, 3000);
    });
  }).on("error", (err) => {
    console.error(`Cannot connect to Max daemon at ${API_BASE}: ${err.message}`);
    console.error("Is the daemon running? Start it with: npm run daemon");
    setTimeout(connectSSE, 5000);
  });
}

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
          console.error(`Error: ${data}`);
          rl.prompt();
        }
      });
    }
  );

  req.on("error", (err) => {
    console.error(`Failed to send: ${err.message}`);
    rl.prompt();
  });

  req.write(body);
  req.end();
}

/** Helper: GET a JSON endpoint and call back with parsed result. */
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
    console.error(`Error: ${err.message}`);
    rl.prompt();
  });
}

/** Helper: POST a JSON endpoint and call back with parsed result. */
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
    console.error(`Error: ${err.message}`);
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
      process.stdout.write(`\r\x1b[K`);
      console.log("⛔ Cancelled.\n");
      rl.prompt();
    });
  });
  req.on("error", (err) => {
    console.error(`Failed to cancel: ${err.message}`);
    rl.prompt();
  });
  req.end();
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("Max TUI — Connecting to daemon...\n");

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

    if (trimmed === "/quit" || trimmed === "/exit") {
      console.log("Bye.");
      process.exit(0);
    }

    if (trimmed === "/cancel") {
      sendCancel();
      return;
    }

    if (trimmed === "/sessions" || trimmed === "/workers") {
      apiGet("/sessions", (sessions: any[]) => {
        if (sessions.length === 0) {
          console.log("No active worker sessions.\n");
        } else {
          for (const s of sessions) {
            console.log(`  • ${s.name} (${s.workingDir}) — ${s.status}`);
          }
          console.log();
        }
      });
      return;
    }

    if (trimmed === "/status") {
      apiGet("/status", (data: any) => {
        console.log(JSON.stringify(data, null, 2) + "\n");
      });
      return;
    }

    if (trimmed.startsWith("/model")) {
      const arg = trimmed.slice(6).trim();
      if (arg) {
        apiPost("/model", { model: arg }, (data: any) => {
          if (data.error) {
            console.log(`Error: ${data.error}\n`);
          } else {
            console.log(`Model: ${data.previous} → ${data.current}\n`);
          }
        });
      } else {
        apiGet("/model", (data: any) => {
          console.log(`Current model: ${data.model}\n`);
        });
      }
      return;
    }

    if (trimmed === "/memory") {
      apiGet("/memory", (memories: any[]) => {
        if (memories.length === 0) {
          console.log("No memories stored.\n");
        } else {
          for (const m of memories) {
            console.log(`  #${m.id} [${m.category}] ${m.content}`);
          }
          console.log(`\n${memories.length} memory/memories total.\n`);
        }
      });
      return;
    }

    if (trimmed === "/skills") {
      apiGet("/skills", (skills: any[]) => {
        if (skills.length === 0) {
          console.log("No skills installed.\n");
        } else {
          for (const s of skills) {
            console.log(`  • ${s.name} (${s.source}) — ${s.description}`);
          }
          console.log();
        }
      });
      return;
    }

    if (trimmed === "/restart") {
      apiPost("/restart", {}, () => {
        console.log("⏳ Max is restarting...\n");
      });
      return;
    }

    if (trimmed === "/clear") {
      console.clear();
      rl.prompt();
      return;
    }

    if (trimmed === "/help") {
      console.log("Commands:");
      console.log("  /cancel             — Cancel the current message");
      console.log("  /model              — Show current model");
      console.log("  /model <name>       — Switch model");
      console.log("  /memory             — Show stored memories");
      console.log("  /skills             — List installed skills");
      console.log("  /workers            — List active worker sessions");
      console.log("  /restart            — Restart Max daemon");
      console.log("  /status             — Daemon health check");
      console.log("  /clear              — Clear the screen");
      console.log("  /quit               — Exit the TUI");
      console.log("  /help               — Show this help");
      console.log();
      console.log("  Tip: Press Escape to cancel a running message");
      console.log("  (anything else is sent to Max)\n");
      rl.prompt();
      return;
    }

    // Send to orchestrator
    sendMessage(trimmed);
  });

  rl.on("close", () => {
    console.log("\nBye.");
    process.exit(0);
  });
}, 1000);
