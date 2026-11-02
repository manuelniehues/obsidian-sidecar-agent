// Parsing without Obsidian (src/transcript.js): reading view, usage limit, Antigravity tail, screen and clipboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { FIX } from "./helpers.mjs";
import { agyTail, creditsShown, findUsageLimit, ingestLine, osc52Text, parseResetText, toMs, touchesFile } from "../src/transcript.js";

const claudeLines = fs.readFileSync(path.join(FIX, "claude", "11111111-2222-3333-4444-555555555555.jsonl"), "utf8").split("\n").filter(Boolean);

test("reading view: turns from the session file", () => {
  const turns = [];
  for (const l of claudeLines) ingestLine(turns, l);
  assert.deepEqual(
    turns.map((x) => x.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(turns[0].text, "Fasse die Notiz zusammen");
  const a = turns[1].parts.map((p) => p.kind);
  assert.deepEqual(a, ["text", "tool", "tool", "text"]);
  assert.match(turns[1].parts[1].text, /^Read: \/vault\/Projekte\/Plan Ä\.md/);
  assert.match(turns[1].parts[2].text, /^Bash: Größe prüfen/);
  assert.equal(turns[3].parts.at(-1).kind, "error");
  assert.ok(!turns.some((x) => x.parts?.some((p) => p.text.includes("Sidechain"))), "subagent lines are skipped");
});

test("usage limit at the end is found, a later answer clears it", () => {
  const rec = findUsageLimit(claudeLines);
  assert.ok(rec);
  assert.equal(rec.apiError, "usage_limit_reached");
  const later = [...claudeLines, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "weiter" }] } })];
  assert.equal(findUsageLimit(later), null);
  assert.equal(findUsageLimit(claudeLines.slice(0, 5)), null);
});

test("reset time from the limit message", () => {
  const at = new Date(2026, 10, 2, 13, 34).getTime();
  const r = new Date(parseResetText("resets 4:20pm (Europe/Berlin)", at));
  assert.equal(r.getHours(), 16);
  assert.equal(r.getMinutes(), 20);
  assert.equal(r.getDate(), 2);
  const r2 = new Date(parseResetText("resets 10am", at));
  assert.equal(r2.getDate(), 3, "a time before the limit is on the next day");
  assert.equal(toMs(1793652600), 1793652600000);
  assert.equal(toMs("2026-11-02T10:00:00Z"), Date.parse("2026-11-02T10:00:00Z"));
});

test("Antigravity tail: tokens and whether the answer is complete", () => {
  const f = path.join(FIX, "agy", "brain", "aaaaaaaa-0000-0000-0000-000000000001", ".system_generated", "logs", "transcript.jsonl");
  const text = fs.readFileSync(f, "utf8");
  const r = agyTail(text);
  assert.equal(r.used_tokens, 33500);
  assert.equal(r.final, true);
  assert.match(r.text, /drei Schritte/);
  const running = agyTail(text.split("\n").slice(0, 3).join("\n"));
  assert.equal(running.final, false, "a GENERIC step after tool calls means agy is still working");
  assert.equal(running.used_tokens, 29000);
  assert.equal(agyTail('{"step_index":1,"inp'), null, "a cut-off chunk gives nothing");
  // agy moved a long command to a background task and ended its turn: it continues by itself later
  const bg = [
    text.split("\n")[0],
    JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 100, tool_calls: [{ name: "run_command" }] }),
    JSON.stringify({ step_index: 2, type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: c1/task-2\nTask Description: sleep 25" }),
    JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 120 }),
  ];
  const b = agyTail(bg.join("\n"));
  assert.deepEqual([b.final, b.background], [false, 1]);
  // its end arrives as a system message, the step itself stays RUNNING
  const end = [
    ...bg,
    JSON.stringify({ step_index: 4, type: "SYSTEM_MESSAGE", status: "DONE", content: '<SYSTEM_MESSAGE>[Message] content=Task id "c1/task-2" finished with result:\nCommand exited with code 0.</SYSTEM_MESSAGE>' }),
    JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 130, content: "FERTIG" }),
  ];
  const e = agyTail(end.join("\n"));
  assert.deepEqual([e.final, e.background, e.text], [true, 0, "FERTIG"]);
});

test("usage credits only from Claude's footer", () => {
  const box = "─".repeat(40);
  assert.equal(creditsShown(["Antwort", box, "> ", box, "  ⏵⏵ auto mode on · Now using usage credits"]), true);
  assert.equal(creditsShown(["In Rieth stand „Now using usage credits“.", box, "> ", box, "  ⏵⏵ auto mode on"]), false);
  assert.equal(creditsShown(["x", box, "> ", box, "You're now using extra usage"]), true);
});

test("OSC 52 clipboard payload", () => {
  assert.equal(osc52Text("c;" + Buffer.from("Grüße ✓").toString("base64")), "Grüße ✓");
  assert.equal(osc52Text("c;?"), null);
  assert.equal(osc52Text("garbage"), null);
});

test("session touches the note: exact, folder suffix, NFD paths; bare names do not count", () => {
  const files = ["Projekte/Plan Ä.md", "Second Brain/log.md", "index.md"];
  assert.ok(touchesFile(files, "Projekte/Plan Ä.md"));
  assert.ok(touchesFile(files, "Projekte/Plan A\u0308.md"), "macOS file names may come decomposed");
  assert.ok(touchesFile(files, "AI AGENTS/Second Brain/log.md"));
  assert.ok(!touchesFile(files, "DEKRA/index.md"));
  assert.ok(!touchesFile([], "x.md"));
});
