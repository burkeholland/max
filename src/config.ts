import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { ENV_PATH, ensureMaxHome } from "./paths.js";

// Load from ~/.max/.env, fall back to cwd .env for dev
loadEnv({ path: ENV_PATH });
loadEnv(); // also check cwd for backwards compat

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  AUTHORIZED_USER_ID: z.string().min(1).optional(),
  API_PORT: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
  ECO_MODE: z.string().optional(),
  ECO_SIMPLE_MODEL: z.string().optional(),
  ECO_MEDIUM_MODEL: z.string().optional(),
  ECO_COMPLEX_MODEL: z.string().optional(),
});

const raw = configSchema.parse(process.env);

const parsedUserId = raw.AUTHORIZED_USER_ID
  ? parseInt(raw.AUTHORIZED_USER_ID, 10)
  : undefined;
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (parsedUserId !== undefined && (Number.isNaN(parsedUserId) || parsedUserId <= 0)) {
  throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

let _copilotModel = raw.COPILOT_MODEL || "claude-sonnet-4.6";
let _ecoMode = raw.ECO_MODE === "1";
/** Saved model before eco mode took over — restored when eco mode is disabled. */
let _manualModel = _copilotModel;

const DEFAULT_ECO_TIERS = {
  simple: "gpt-4.1",
  medium: "claude-sonnet-4.6",
  complex: "claude-opus-4.6",
} as const;

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  get copilotModel(): string {
    return _copilotModel;
  },
  set copilotModel(model: string) {
    _copilotModel = model;
  },
  get ecoMode(): boolean {
    return _ecoMode;
  },
  set ecoMode(enabled: boolean) {
    _ecoMode = enabled;
  },
  get manualModel(): string {
    return _manualModel;
  },
  set manualModel(model: string) {
    _manualModel = model;
  },
  get ecoTiers(): { simple: string; medium: string; complex: string } {
    return {
      simple: raw.ECO_SIMPLE_MODEL || DEFAULT_ECO_TIERS.simple,
      medium: raw.ECO_MEDIUM_MODEL || DEFAULT_ECO_TIERS.medium,
      complex: raw.ECO_COMPLEX_MODEL || DEFAULT_ECO_TIERS.complex,
    };
  },
  get telegramEnabled(): boolean {
    return !!this.telegramBotToken && this.authorizedUserId !== undefined;
  },
  get selfEditEnabled(): boolean {
    return process.env.MAX_SELF_EDIT === "1";
  },
};

/** Persist the current model choice to ~/.max/.env */
export function persistModel(model: string): void {
  persistEnvVar("COPILOT_MODEL", model);
}

/** Persist eco mode preference to ~/.max/.env */
export function persistEcoMode(enabled: boolean): void {
  persistEnvVar("ECO_MODE", enabled ? "1" : "0");
}

/** Write a key=value pair to ~/.max/.env, creating or updating as needed. */
function persistEnvVar(key: string, value: string): void {
  ensureMaxHome();
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    writeFileSync(ENV_PATH, updated.join("\n"));
  } catch {
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
  }
}
