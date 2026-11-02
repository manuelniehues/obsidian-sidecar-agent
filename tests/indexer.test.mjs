// Session index (src/py/indexer.py) against the sample files: titles, prompts, model, touched vault files.
import { test } from "node:test";
import assert from "node:assert/strict";
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
