import test from "node:test";
import assert from "node:assert/strict";
import { FileTracker } from "../src/transcript.js";

const line = (o) => JSON.stringify(o);
const use = (name, input, ts) => line({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id: "x", name, input }] } });

test("FileTracker lists context files and edits, compacting empties the context", () => {
  const f = new FileTracker();
  assert.equal(f.feed(line({ type: "attachment", timestamp: "2026-11-21T10:00:00Z", attachment: { type: "instructions", files: [{ path: "/v/AGENTS.md" }] } })), true);
  f.feed(use("Read", { file_path: "/v/a.md" }, "2026-11-21T10:01:00Z"));
  f.feed(line({ type: "attachment", timestamp: "2026-11-21T10:02:00Z", attachment: { type: "file", filename: "/v/b.md" } }));
  f.feed(use("Edit", { file_path: "/v/c.md" }, "2026-11-21T10:03:00Z"));
  f.feed(line({ type: "assistant", isSidechain: true, timestamp: "2026-11-21T10:04:00Z", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/v/sub.md" } }] } }));
  assert.equal(f.feed(use("Bash", { command: "cat x" }, "2026-11-21T10:05:00Z")), false);
  assert.deepEqual(f.contextFiles().map((x) => [x.abs, x.how]), [["/v/c.md", "read"], ["/v/b.md", "mention"], ["/v/a.md", "read"], ["/v/AGENTS.md", "instructions"]]);
  assert.deepEqual(f.editedSince(Date.parse("2026-11-21T10:02:30Z")).map((x) => x.abs), ["/v/c.md"]);
  assert.deepEqual(f.editedSince(Date.parse("2026-11-21T10:05:00Z")), []);
  f.feed(line({ type: "user", isCompactSummary: true, timestamp: "2026-11-21T11:00:00Z", message: { content: "summary" } }));
  assert.deepEqual(f.contextFiles(), []);
  f.feed(line({ type: "attachment", timestamp: "2026-11-21T11:00:01Z", attachment: { type: "compact_file_reference", filename: "/v/AGENTS.md" } }));
  assert.deepEqual(f.contextFiles().map((x) => x.how), ["compact"]);
});

test("SkillTracker lists skills from /commands and the Skill tool, newest first", async () => {
  const { SkillTracker } = await import("../src/transcript.js");
  const sk = new SkillTracker();
  const meta = (dir, ts) => JSON.stringify({ type: "user", isMeta: true, timestamp: ts, message: { content: [{ type: "text", text: `Base directory for this skill: ${dir}\n\n# Skill` }] } });
  assert.equal(sk.feed(meta("/v/.claude/skills/gutachten", "2026-11-21T10:00:00Z")), true);
  sk.feed(meta("/Users/x/.claude/skills/vermenschlichen", "2026-11-21T10:05:00Z"));
  sk.feed(meta("/v/.claude/skills/gutachten", "2026-11-21T10:10:00Z"));
  assert.deepEqual(sk.list().map((x) => x.name), ["gutachten", "vermenschlichen"]);
  assert.equal(sk.feed(JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "s" } })), true);
  assert.deepEqual(sk.list(), []);
});
