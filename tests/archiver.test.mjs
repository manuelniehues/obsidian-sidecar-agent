// Chat notes in the vault: src/py/archiver.py with sample sessions.
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { test } from "node:test";
import { FIX, agyDb, runPy, tmpDir } from "./helpers.mjs";

const CLAUDE_ID = "11111111-2222-3333-4444-555555555555";
const AGY_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const LABELS = { you: "You", assistant: "Assistant", notice: "Written by the plugin.", cut: "Shortened.", tool: "tool call", tools: "tool calls" };

function setup() {
  const dir = tmpDir();
  const claudeDir = path.join(dir, "claude");
  fs.cpSync(path.join(FIX, "claude"), claudeDir, { recursive: true });
  return { dir, claudeDir, folder: path.join(dir, "vault", "Chats"), cache: path.join(dir, "archive.json"), agyDb: agyDb(dir) };
}

function run(env, over = {}) {
  const args = {
    chats: [{ agent: "claude", id: CLAUDE_ID, title: "My chat" }],
    folder: env.folder,
    cache: env.cache,
    claudeDir: env.claudeDir,
    agyDb: env.agyDb,
    quietMs: 0,
    labels: LABELS,
    ...over,
  };
  return JSON.parse(runPy("archiver.py", { args: [JSON.stringify(args)] }).stdout);
}

function notes(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f)) : [];
}

test("Claude: one note with frontmatter, without the context block and tool results", () => {
  const env = setup();
  assert.equal(run(env).written, 1);
  const [note] = notes(env.folder);
  assert.match(path.basename(note), /^\d{4}-\d{2}-\d{2} \d{4} My chat\.md$/);
  const text = fs.readFileSync(note, "utf8");
  assert.match(text, new RegExp(`^---\\nchat_id: claude-${CLAUDE_ID}\\ntitle: "My chat"\\nagent: claude\\n`));
  assert.match(text, /## You · /);
  assert.match(text, /Fasse die Notiz zusammen/);
  assert.doesNotMatch(text, /obsidian_context/);
});

test("Antigravity: user request and answers from the transcript", () => {
  const env = setup();
  const r = run(env, { chats: [{ agent: "agy", id: AGY_ID, title: "Plan" }] });
  assert.equal(r.written, 1);
  const text = fs.readFileSync(notes(env.folder)[0], "utf8");
  assert.match(text, /^chat_id: agy-aaaaaaaa/m);
  assert.match(text, /^agent: agy$/m);
  assert.match(text, /## You/);
  assert.match(text, /## Assistant/);
});

test("nothing is rewritten without a change, and a new title renames the note", () => {
  const env = setup();
  run(env);
  const second = run(env);
  assert.equal(second.written + second.renamed, 0);
  assert.equal(run(env, { chats: [{ agent: "claude", id: CLAUDE_ID, title: "New name" }] }).renamed, 1);
  const list = notes(env.folder);
  assert.equal(list.length, 1);
  assert.match(list[0], /New name\.md$/);
});

test("a device with an older copy of the session leaves a newer note alone", () => {
  const env = setup();
  run(env);
  const [note] = notes(env.folder);
  const newer = fs.readFileSync(note, "utf8").replace(/^source_updated: \d+$/m, "source_updated: 9999999999999");
  fs.writeFileSync(note, newer);
  fs.rmSync(env.cache);
  run(env, { chats: [{ agent: "claude", id: CLAUDE_ID, title: "My chat" }] });
  assert.equal(fs.readFileSync(note, "utf8"), newer);
});

test("a session still being written waits, unless its turn just ended", () => {
  const env = setup();
  const r = run(env, { quietMs: 3600000 });
  assert.equal(r.pending, 1);
  assert.equal(notes(env.folder).length, 0);
  run(env, { quietMs: 3600000, now: [`claude:${CLAUDE_ID}`] });
  assert.equal(notes(env.folder).length, 1);
});

test("older sessions stay out with a start date, notes of other chats stay untouched", () => {
  const env = setup();
  fs.mkdirSync(env.folder, { recursive: true });
  const other = path.join(env.folder, "old.md");
  fs.writeFileSync(other, "---\nchat_id: conv-1\n---\nOld\n");
  run(env, { from: "2999-01-01" });
  assert.deepEqual(notes(env.folder), [other]);
});

test("a chat too long for a synced note loses its oldest turns, not the file", () => {
  const env = setup();
  const line = (type, i, text) =>
    JSON.stringify({ type, uuid: `${type}${i}`, timestamp: "2026-11-02T10:00:00.000Z", message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  const big = "x".repeat(900000);
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(line("user", i, `Question ${i}`), line("assistant", i, big));
  fs.writeFileSync(path.join(env.claudeDir, `${CLAUDE_ID}.jsonl`), rows.join("\n") + "\n");
  run(env);
  const [note] = notes(env.folder);
  assert.ok(fs.statSync(note).size < 5000000);
  const text = fs.readFileSync(note, "utf8");
  assert.match(text, /Shortened\./);
  assert.match(text, /Question 7/);
});

test("full-text search finds chat notes", () => {
  const env = setup();
  run(env);
  const args = { mode: "search", query: "fasse DIE notiz", rg: "", vault: "/vault", claudeDir: env.dir, agyDb: env.agyDb, archiveDir: env.folder };
  const r = JSON.parse(runPy("indexer.py", { args: [JSON.stringify(args)] }).stdout);
  assert.deepEqual(r.archive, [`claude-${CLAUDE_ID}`]);
});
