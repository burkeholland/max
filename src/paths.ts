import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

/** Base directory for all Max user data: ~/.max */
export const MAX_HOME = join(homedir(), ".max");

/** Path to the SQLite database */
export const DB_PATH = join(MAX_HOME, "max.db");

/** Path to the user .env file */
export const ENV_PATH = join(MAX_HOME, ".env");

/** Path to user-local skills */
export const SKILLS_DIR = join(MAX_HOME, "skills");

/** Path to Max's isolated session state (keeps CLI history clean) */
export const SESSIONS_DIR = join(MAX_HOME, "sessions");

/** Path to TUI readline history */
export const HISTORY_PATH = join(MAX_HOME, "tui_history");

/** Ensure ~/.max/ exists */
export function ensureMaxHome(): void {
  mkdirSync(MAX_HOME, { recursive: true });
}
