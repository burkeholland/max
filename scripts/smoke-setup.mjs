import { spawn } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "heymax-smoke-home-"));

function runSetupSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/setup.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let sentEnter = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`setup smoke test timed out\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();

      if (!sentEnter && stdout.includes("Press Enter to continue...")) {
        sentEnter = true;
        child.stdin.write("\n");
        child.stdin.end();
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      const combined = `${stdout}\n${stderr}`;

      if (code !== 0) {
        reject(new Error(`setup smoke test failed with exit code ${code}\n\n${combined}`));
        return;
      }

      if (!stdout.includes("Max Setup") || !stdout.includes("Would you like to set up Telegram?")) {
        reject(new Error(`setup smoke test did not reach the interactive prompts\n\n${combined}`));
        return;
      }

      if (combined.includes("ERR_MODULE_NOT_FOUND")) {
        reject(new Error(`setup smoke test reproduced ERR_MODULE_NOT_FOUND\n\n${combined}`));
        return;
      }

      resolve();
    });
  });
}

try {
  await runSetupSmoke();
  console.log("Setup smoke test passed.");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
