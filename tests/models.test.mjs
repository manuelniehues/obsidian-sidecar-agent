import { test } from "node:test";
import assert from "node:assert/strict";
import { sortAgyModels } from "../src/models.js";

test("sortAgyModels orders Gemini 4 tiers and effort levels by capability", () => {
  const input = [
    ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
    ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
    ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
    ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
    ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
    ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
    ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
    ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
    ["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
    ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
    ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
    ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
    ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
  ];

  const sorted = sortAgyModels(input).map(([id]) => id);
  assert.deepEqual(sorted, [
    "gemini-4-carbon-high",
    "gemini-4-carbon-medium",
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-neon-high",
    "gemini-4-neon-medium",
    "gemini-4-hydrogen-high",
    "gemini-4-hydrogen-medium",
    "gemini-3.8-flash-high",
    "gemini-pro-orchestrator",
    "gemini-pro-orchestrator-argon",
    "gemini-pro-orchestrator-neon",
    "claude-opus-5-5-high",
    "claude-opus-5-5-medium",
    "claude-sonnet-5-5-high",
    "gpt-oss-120b-medium",
  ]);
});

test("sortAgyModels does not mutate the input array", () => {
  const input = [
    ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
    ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
  ];
  const copy = [...input];
  sortAgyModels(input);
  assert.deepEqual(input, copy);
});

import { claudeFamilyVersions, claudeModelName, claudeVariants, sortClaudeModels, splitVariant } from "../src/models.js";

test("sortClaudeModels: Fable, Opus, Opus plan, Sonnet, Haiku, newer first", () => {
  const ids = sortClaudeModels(["haiku", "opusplan", "sonnet", "claude-opus-4-6", "opus", "fable", "claude-opus-5-5", "other"].map((x) => [x, x])).map(([id]) => id);
  assert.deepEqual(ids, ["fable", "opus", "claude-opus-5-5", "claude-opus-4-6", "opusplan", "sonnet", "haiku", "other"]);
});

test("Claude names always carry the version", () => {
  assert.equal(claudeModelName("opus"), "Opus 5.5");
  assert.equal(claudeModelName("fable"), "Fable 5.2");
  assert.equal(claudeModelName("opusplan"), "Opus 5.5 Plan");
  assert.equal(claudeModelName("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(claudeModelName("claude-opus-5-5-high"), "Opus 5.5 · High");
  assert.equal(claudeModelName("gemini-4-argon-medium"), "gemini-4-argon-medium");
  // a newer model seen in a transcript wins over the version known at release
  const v = claudeFamilyVersions(["claude-opus-5-7", "claude-opus-4-6", "gemini-4-neon-high"]);
  assert.equal(v.opus, "5.7");
  assert.equal(claudeModelName("opus", v), "Opus 5.7");
});

test("claudeVariants: high before medium per model, with version", () => {
  const v = claudeVariants([["sonnet", "sonnet"], ["opus", "opus"]]);
  assert.deepEqual(v.map((x) => x.label), ["Opus 5.5 · High", "Opus 5.5 · Medium", "Sonnet 5.5 · High", "Sonnet 5.5 · Medium"]);
  assert.deepEqual(splitVariant(v[1].value), { model: "opus", effort: "medium" });
  assert.deepEqual(splitVariant("opus"), { model: "opus" });
});
