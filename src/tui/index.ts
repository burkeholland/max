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

    if (trimmed === "/sessions") {
      const url = new URL("/sessions", API_BASE);
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const sessions = JSON.parse(data);
            if (sessions.length === 0) {
              console.log("No active sessions.\n");
            } else {
              for (const s of sessions) {
                console.log(`  • ${s.name} (${s.workingDir}) — ${s.status}`);
              }
              console.log();
            }
          } catch {
            console.log(data);
          }
          rl.prompt();
        });
      }).on("error", (err) => {
        console.error(`Error: ${err.message}`);
        rl.prompt();
      });
      return;
    }

    if (trimmed === "/status") {
      const url = new URL("/status", API_BASE);
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          console.log(data + "\n");
          rl.prompt();
        });
      }).on("error", (err) => {
        console.error(`Error: ${err.message}`);
        rl.prompt();
      });
      return;
    }

    if (trimmed === "/help") {
      console.log("Commands:");
      console.log("  /sessions  — List worker sessions");
      console.log("  /status    — Daemon health check");
      console.log("  /quit      — Exit the TUI");
      console.log("  /help      — Show this help");
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
