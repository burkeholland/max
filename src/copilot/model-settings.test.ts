import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSupportedReasoningEfforts,
  extractDefaultReasoningEffort,
  pickDefaultReasoningEffort,
  resolveEffectiveReasoningEffort,
  formatReasoningValidationError,
  getUnsupportedReasoningMessage,
} from "./model-settings.js";

test("extracts reasoning options from the SDK model shape", () => {
  const options = extractSupportedReasoningEfforts({
    id: "gpt-5",
    capabilities: {
      supports: { reasoningEffort: true, vision: false },
      limits: { max_context_window_tokens: 1000 },
    },
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
  });

  assert.deepEqual(options, ["low", "medium", "high"]);
  assert.equal(
    extractDefaultReasoningEffort({
      defaultReasoningEffort: "high",
    }),
    "high",
  );
});

test("extracts reasoning options from alternate metadata shapes", () => {
  const options = extractSupportedReasoningEfforts({
    id: "custom-model",
    metadata: {
      reasoning: {
        options: ["low", "medium"],
        defaultReasoningEffort: "low",
      },
    },
  });

  assert.deepEqual(options, ["low", "medium"]);
  assert.equal(
    extractDefaultReasoningEffort({
      metadata: {
        reasoning: {
          defaultReasoningEffort: "low",
        },
      },
    }),
    "low",
  );
});

test("prefers medium when choosing a default reasoning effort", () => {
  assert.equal(
    pickDefaultReasoningEffort(["low", "medium", "high"], "high"),
    "medium",
  );
  assert.equal(
    pickDefaultReasoningEffort(["low", "high"], "high"),
    "high",
  );
});

test("reuses the stored reasoning when still valid", () => {
  assert.equal(
    resolveEffectiveReasoningEffort(["low", "medium", "high"], "high", "medium"),
    "high",
  );
  assert.equal(
    resolveEffectiveReasoningEffort(["low", "medium", "high"], "xhigh", "medium"),
    "medium",
  );
});

test("formats reasoning validation failures with helpful hints", () => {
  assert.equal(
    formatReasoningValidationError("medum", ["low", "medium", "high"]),
    "Invalid reasoning effort 'medum'. Did you mean: medium?",
  );
  assert.equal(
    formatReasoningValidationError("turbo", ["low", "medium", "high"]),
    "Invalid reasoning effort 'turbo'. Available options: low, medium, high",
  );
});

test("reports the required unsupported reasoning error message", () => {
  assert.equal(
    getUnsupportedReasoningMessage("claude-sonnet-4.6"),
    "The current model claude-sonnet-4.6 does not support reasoning efforts",
  );
});
