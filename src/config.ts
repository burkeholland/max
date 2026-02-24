import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  AUTHORIZED_USER_ID: z.string().min(1),
  API_PORT: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
});

const raw = configSchema.parse(process.env);

const parsedUserId = parseInt(raw.AUTHORIZED_USER_ID, 10);
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (Number.isNaN(parsedUserId) || parsedUserId <= 0) {
  throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  copilotModel: raw.COPILOT_MODEL || "claude-sonnet-4.5",
} as const;
