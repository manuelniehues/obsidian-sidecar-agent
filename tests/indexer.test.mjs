// Session index (src/py/indexer.py) against the sample files: titles, prompts, model, touched vault files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { FIX, agyDb, runPy, tmpDir } from "./helpers.mjs";

function index(extra = {}) {
  const dir = tmpDir();
  const args = { mode: "index", vault: "/vault", claudeDir: path.join(FIX, "claude"), agyDb: agyDb(dir), cache: path.join(dir, "index.json"), ...extra };
  return JSON.parse(runPy("indexer.py", { args: [JSON.stringify(args)] }).stdout);
}

test("Claude session: titles, prompts, counts, model", () => {
  const [c] = index().claude;
  assert.equal(c.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(c.customTitle, "Plan-Zusammenfassung");
  assert.equal(c.aiTitle, "Notiz zusammenfassen");
  assert.equal(c.firstPrompt, "Fasse die Notiz zusammen", "obsidian_context must be cut off");
  assert.equal(c.lastPrompt, "Und jetzt bitte");
  assert.equal(c.userMessages, 2, "tool results are no prompts");
  assert.equal(c.model, "claude-opus-5-5", "<synthetic> is skipped");
  assert.equal(c.cwd, "/vault");
});

test("Claude session started with a slash command: counts as prompt, keeps Claude's title", () => {
  const dir = tmpDir();
  const lines = [
    { type: "user", isSidechain: false, message: { role: "user", content: "<command-message>neues-gutachten</command-message>\n<command-name>/neues-gutachten</command-name>\n<command-args>Bemerkbarkeit Muster</command-args>" }, uuid: "c1", timestamp: "2026-11-11T11:35:22.449Z", cwd: "/vault" },
    { type: "user", isMeta: true, isSidechain: false, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /vault/.claude/skills/neues-gutachten" }] }, uuid: "c2", timestamp: "2026-11-11T11:35:22.500Z" },
    { type: "assistant", isSidechain: false, message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Lese die Akte." }] }, uuid: "c3", timestamp: "2026-11-11T11:35:30.000Z" },
    { type: "ai-title", aiTitle: "Gutachten Bemerkbarkeit Muster", sessionId: "22222222-3333-4444-5555-666666666666" },
  ];
  fs.writeFileSync(path.join(dir, "22222222-3333-4444-5555-666666666666.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const [c] = index({ claudeDir: dir, cache: path.join(dir, "index.json") }).claude;
  assert.equal(c.userMessages, 1, "the slash command is the first prompt, the skill text (isMeta) is not");
  assert.equal(c.firstPrompt, "/neues-gutachten Bemerkbarkeit Muster");
  assert.equal(c.aiTitle, "Gutachten Bemerkbarkeit Muster");
});

test("Claude session: vault files from tools, shell commands and @ mentions", () => {
  const files = index().claude[0].files;
  for (const f of ["Projekte/Plan Ä.md", "Second Brain/log.md", "notes/hot.md", "Projekte/Mit Leer.md", "notes/kurz.md"]) assert.ok(files.includes(f), `missing ${f}: ${files}`);
  assert.ok(!files.includes("Projekte/Offen.md"), "the open note from the context hook is no touched file");
  assert.ok(!files.includes("Sidechain.md"), "subagent calls are skipped");
  assert.ok(!files.some((f) => f.includes("$") || f.startsWith("/")), `no variables or outside paths: ${files}`);
});

test("Antigravity: vault conversations only, no subagents, files from the transcript", () => {
  const agy = index().agy;
  assert.deepEqual(
    agy.map((a) => a.id),
    ["aaaaaaaa-0000-0000-0000-000000000001"],
  );
  assert.equal(agy[0].title, "Plan lesen");
  assert.ok(agy[0].updated > 0);
  assert.deepEqual(agy[0].files.sort(), ["Projekte/Plan Ä.md", "notes/hot.md"]);
});

test("Antigravity: conversations without a stored folder appear when the plugin started them", () => {
  const ids = index({ agyIds: ["aaaaaaaa-0000-0000-0000-000000000004"] }).agy.map((a) => a.id);
  assert.deepEqual(ids.sort(), ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000004"]);
});

test("full-text search: Claude files (also umlauts in other case without ripgrep), Antigravity titles", () => {
  const dir = tmpDir();
  const search = (query) => {
    const args = { mode: "search", query, rg: "", vault: "/vault", claudeDir: path.join(FIX, "claude"), agyDb: agyDb(dir) };
    return JSON.parse(runPy("indexer.py", { args: [JSON.stringify(args)] }).stdout);
  };
  assert.deepEqual(search("plan ä").claude, ["11111111-2222-3333-4444-555555555555"]);
  const r = search("Lies den Plan");
  assert.deepEqual(r.agy, ["aaaaaaaa-0000-0000-0000-000000000001"]);
  assert.deepEqual(search("gibt es nicht").claude, []);
});
