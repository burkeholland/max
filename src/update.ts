import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec as execCb, execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Run a command asynchronously and return stdout. */
function execAsync(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execCb(cmd, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

/** Fetch the latest published version from npm. Returns null on failure. */
export async function getLatestVersion(): Promise<string | null> {
  try {
    const result = await execAsync("npm view heymax version", 10_000);
    return result || null;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns true if remote is newer. */
function isNewer(local: string, remote: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [lMaj, lMin, lPat] = parse(local);
  const [rMaj, rMin, rPat] = parse(remote);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** false when the npm registry could not be reached */
  checkSucceeded: boolean;
}

/** Check whether a newer version is available on npm. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getLocalVersion();
  const latest = await getLatestVersion();
  return {
    current,
    latest,
    updateAvailable: latest !== null && isNewer(current, latest),
    checkSucceeded: latest !== null,
  };
}

/**
 * Versioned changelog — add an entry here for every release that has
 * user-visible changes worth announcing. Key = exact semver published to npm.
 */
const CHANGELOG: Record<string, string> = {
  "1.2.0": [
    "• WorkIQ — connect your Microsoft 365 data (email, calendar, Teams",
    "  messages, SharePoint docs, and more). Run `max setup` to enable it.",
  ].join("\n"),
};

/**
 * Return a "what's new" message covering all versions after `from` up to
 * and including `to`. Returns null if there's nothing to announce.
 */
export function getWhatsNew(from: string, to: string): string | null {
  // Strip prerelease/build metadata (e.g. "1.2.0-beta.1" → "1.2.0") before parsing
  const normalize = (v: string) => v.replace(/[-+].*$/, "");
  const parse = (v: string) => normalize(v).split(".").map(Number) as [number, number, number];
  const gt = (a: [number, number, number], b: [number, number, number]) => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };

  const fromParsed = parse(from);
  const toParsed = parse(to);

  const entries = Object.entries(CHANGELOG)
    .filter(([v]) => {
      const p = parse(v);
      return gt(p, fromParsed) && !gt(p, toParsed);
    })
    .sort(([a], [b]) => {
      const pa = parse(a), pb = parse(b);
      return gt(pa, pb) ? 1 : -1;
    });

  if (entries.length === 0) return null;

  const lines = [`🆕 Max v${to} is here!\n`];
  for (const [, notes] of entries) {
    lines.push(notes);
  }
  return lines.join("\n");
}

/** Run `npm install -g heymax@latest` and return success/failure. */
export async function performUpdate(): Promise<{ ok: boolean; output: string }> {
  try {
    const output = execSync("npm install -g heymax@latest", {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.message || "Unknown error";
    return { ok: false, output: msg };
  }
}
