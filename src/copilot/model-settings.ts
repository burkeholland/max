import type { CopilotClient } from "@github/copilot-sdk";
import { config, persistModel, persistReasoning } from "../config.js";

const MODEL_CACHE_TTL_MS = 60_000;
const PREFERRED_DEFAULT_REASONING = "medium";

type UnknownRecord = Record<string, unknown>;
type SdkReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ModelSelectionInfo {
  model: string;
  reasoning?: string;
  availableReasoningEfforts?: string[];
}

export interface ModelSwitchResult extends ModelSelectionInfo {
  previous: string;
  current: string;
}

export interface ReasoningChangeResult extends ModelSelectionInfo {
  previous?: string;
  current: string;
}

interface ModelReasoningProbe {
  model: string;
  metadataAvailable: boolean;
  modelFound: boolean;
  availableReasoningEfforts: string[];
  defaultReasoningEffort?: string;
}

let cachedModels:
  | {
      fetchedAt: number;
      models: unknown[];
    }
  | undefined;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function extractSupportedReasoningEfforts(model: unknown): string[] {
  const arrayPaths = [
    ["supportedReasoningEfforts"],
    ["reasoningEfforts"],
    ["reasoning", "supportedReasoningEfforts"],
    ["reasoning", "efforts"],
    ["reasoning", "options"],
    ["capabilities", "supportedReasoningEfforts"],
    ["capabilities", "reasoningEfforts"],
    ["capabilities", "reasoning", "supportedReasoningEfforts"],
    ["capabilities", "reasoning", "options"],
    ["metadata", "supportedReasoningEfforts"],
    ["metadata", "reasoning", "supportedReasoningEfforts"],
    ["metadata", "reasoning", "options"],
  ] as const;

  for (const path of arrayPaths) {
    const value = readPath(model, path);
    if (Array.isArray(value)) {
      const options = uniqueStrings(value);
      if (options.length > 0) return options;
    }
  }

  return [];
}

export function extractDefaultReasoningEffort(model: unknown): string | undefined {
  const defaultPaths = [
    ["defaultReasoningEffort"],
    ["reasoning", "defaultReasoningEffort"],
    ["reasoning", "default"],
    ["capabilities", "defaultReasoningEffort"],
    ["capabilities", "reasoning", "defaultReasoningEffort"],
    ["metadata", "defaultReasoningEffort"],
    ["metadata", "reasoning", "defaultReasoningEffort"],
  ] as const;

  for (const path of defaultPaths) {
    const value = readPath(model, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function pickDefaultReasoningEffort(
  availableReasoningEfforts: string[],
  advertisedDefault?: string,
): string | undefined {
  if (availableReasoningEfforts.length === 0) return undefined;
  if (availableReasoningEfforts.includes(PREFERRED_DEFAULT_REASONING)) {
    return PREFERRED_DEFAULT_REASONING;
  }
  if (advertisedDefault && availableReasoningEfforts.includes(advertisedDefault)) {
    return advertisedDefault;
  }
  return availableReasoningEfforts[0];
}

export function resolveEffectiveReasoningEffort(
  availableReasoningEfforts: string[],
  preferredReasoning?: string,
  advertisedDefault?: string,
): string | undefined {
  if (availableReasoningEfforts.length === 0) return undefined;
  if (preferredReasoning && availableReasoningEfforts.includes(preferredReasoning)) {
    return preferredReasoning;
  }
  return pickDefaultReasoningEffort(availableReasoningEfforts, advertisedDefault);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

export function suggestClosestOption(input: string, options: string[]): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || options.length === 0) return undefined;

  const exactCaseInsensitive = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  if (exactCaseInsensitive) return exactCaseInsensitive;

  const partial = options.find((option) =>
    option.toLowerCase().includes(trimmed.toLowerCase()) ||
    trimmed.toLowerCase().includes(option.toLowerCase()),
  );
  if (partial) return partial;

  let bestOption: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const distance = levenshtein(trimmed.toLowerCase(), option.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOption = option;
    }
  }

  return bestDistance <= 3 ? bestOption : undefined;
}

export function formatReasoningValidationError(requested: string, availableReasoningEfforts: string[]): string {
  const suggestion = suggestClosestOption(requested, availableReasoningEfforts);
  if (suggestion) {
    return `Invalid reasoning effort '${requested}'. Did you mean: ${suggestion}?`;
  }
  return `Invalid reasoning effort '${requested}'. Available options: ${availableReasoningEfforts.join(", ")}`;
}

export function getUnsupportedReasoningMessage(model: string): string {
  return `The current model ${model} does not support reasoning efforts`;
}

export function toSdkReasoningEffort(reasoning?: string): SdkReasoningEffort | undefined {
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high" || reasoning === "xhigh") {
    return reasoning;
  }
  return undefined;
}

async function resolveClient(client?: CopilotClient): Promise<CopilotClient | undefined> {
  if (client) return client;

  try {
    const { getClient } = await import("./client.js");
    return await getClient();
  } catch (err) {
    console.debug(`[max] Reasoning probe unavailable: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

async function listModelsCached(client?: CopilotClient): Promise<unknown[] | undefined> {
  const now = Date.now();
  if (cachedModels && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.models;
  }

  const resolvedClient = await resolveClient(client);
  if (!resolvedClient) return undefined;

  try {
    const models = await resolvedClient.listModels();
    cachedModels = { fetchedAt: now, models };
    return models;
  } catch (err) {
    console.debug(`[max] Failed to load model metadata: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

function findModel(models: unknown[], modelId: string): unknown | undefined {
  return models.find((candidate) => readPath(candidate, ["id"]) === modelId);
}

async function probeModelReasoning(model: string, client?: CopilotClient): Promise<ModelReasoningProbe> {
  const models = await listModelsCached(client);
  if (!models) {
    return {
      model,
      metadataAvailable: false,
      modelFound: false,
      availableReasoningEfforts: [],
    };
  }

  const match = findModel(models, model);
  if (!match) {
    return {
      model,
      metadataAvailable: true,
      modelFound: false,
      availableReasoningEfforts: [],
    };
  }

  return {
    model,
    metadataAvailable: true,
    modelFound: true,
    availableReasoningEfforts: extractSupportedReasoningEfforts(match),
    defaultReasoningEffort: extractDefaultReasoningEffort(match),
  };
}

export async function getActiveModelSelection(client?: CopilotClient): Promise<ModelSelectionInfo> {
  const probe = await probeModelReasoning(config.copilotModel, client);
  const selection: ModelSelectionInfo = { model: config.copilotModel };

  if (probe.availableReasoningEfforts.length > 0) {
    selection.availableReasoningEfforts = probe.availableReasoningEfforts;
    selection.reasoning = resolveEffectiveReasoningEffort(
      probe.availableReasoningEfforts,
      config.copilotReasoning,
      probe.defaultReasoningEffort,
    );
  }

  return selection;
}

export async function syncConfiguredReasoning(client?: CopilotClient): Promise<void> {
  const probe = await probeModelReasoning(config.copilotModel, client);
  if (probe.availableReasoningEfforts.length === 0) return;

  const reasoning = resolveEffectiveReasoningEffort(
    probe.availableReasoningEfforts,
    config.copilotReasoning,
    probe.defaultReasoningEffort,
  );
  if (!reasoning || reasoning === config.copilotReasoning) return;

  config.copilotReasoning = reasoning;
  persistReasoning(reasoning);
}

export async function getEffectiveSelectionForModel(model: string, client?: CopilotClient): Promise<ModelSelectionInfo> {
  const probe = await probeModelReasoning(model, client);
  const selection: ModelSelectionInfo = { model };

  if (probe.availableReasoningEfforts.length > 0) {
    selection.availableReasoningEfforts = probe.availableReasoningEfforts;
    selection.reasoning = resolveEffectiveReasoningEffort(
      probe.availableReasoningEfforts,
      config.copilotReasoning,
      probe.defaultReasoningEffort,
    );
  }

  return selection;
}

export async function switchConfiguredModel(model: string, client?: CopilotClient): Promise<ModelSwitchResult> {
  const models = await listModelsCached(client);
  if (models) {
    const match = findModel(models, model);
    if (!match) {
      const modelIds = uniqueStrings(models.map((candidate) => readPath(candidate, ["id"])));
      const suggestion = suggestClosestOption(model, modelIds);
      const hint = suggestion ? ` Did you mean: ${suggestion}?` : "";
      throw new Error(`Model '${model}' not found.${hint}`);
    }
  }

  const previous = config.copilotModel;
  config.copilotModel = model;
  persistModel(model);

  const probe = await probeModelReasoning(model, client);
  if (probe.availableReasoningEfforts.length > 0) {
    const reasoning = pickDefaultReasoningEffort(
      probe.availableReasoningEfforts,
      probe.defaultReasoningEffort,
    );
    if (reasoning) {
      config.copilotReasoning = reasoning;
      persistReasoning(reasoning);
      return {
        previous,
        current: model,
        model,
        reasoning,
        availableReasoningEfforts: probe.availableReasoningEfforts,
      };
    }
  }

  return { previous, current: model, model };
}

export async function setConfiguredReasoningEffort(
  requested: string,
  client?: CopilotClient,
): Promise<ReasoningChangeResult> {
  const probe = await probeModelReasoning(config.copilotModel, client);
  if (!probe.metadataAvailable || !probe.modelFound) {
    throw new Error(`Unable to validate reasoning efforts for the current model ${config.copilotModel}.`);
  }
  if (probe.availableReasoningEfforts.length === 0) {
    throw new Error(getUnsupportedReasoningMessage(config.copilotModel));
  }
  if (!probe.availableReasoningEfforts.includes(requested)) {
    throw new Error(formatReasoningValidationError(requested, probe.availableReasoningEfforts));
  }

  const previous = resolveEffectiveReasoningEffort(
    probe.availableReasoningEfforts,
    config.copilotReasoning,
    probe.defaultReasoningEffort,
  );

  config.copilotReasoning = requested;
  persistReasoning(requested);

  return {
    model: config.copilotModel,
    previous,
    current: requested,
    reasoning: requested,
    availableReasoningEfforts: probe.availableReasoningEfforts,
  };
}

export function resetModelMetadataCache(): void {
  cachedModels = undefined;
}
