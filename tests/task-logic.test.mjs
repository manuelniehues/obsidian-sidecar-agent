// Inbox and task buttons (src/task-logic.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { diskFiles, fillPrompt, ignoredName, inHours, parseFolders, sessionPhase } from "../src/task-logic.js";
import { tmpDir } from "./helpers.mjs";

test("time window: plain, past midnight, empty", () => {
  const d = (h, m = 0) => new Date(2026, 10, 25, h, m);
  assert.equal(inHours("08:00-20:00", d(7, 59)), false);
  assert.equal(inHours("08:00-20:00", d(8)), true);
  assert.equal(inHours("08:00-20:00", d(20)), false);
  assert.equal(inHours("22:00-06:00", d(23)), true);
  assert.equal(inHours("22:00-06:00", d(5, 59)), true);
  assert.equal(inHours("22:00-06:00", d(12)), false);
  assert.equal(inHours("8-20", d(9)), true);
  assert.equal(inHours("", d(3)), true);
  assert.equal(inHours("nonsense", d(3)), true);
});

test("message placeholders", () => {
  const out = fillPrompt("Ordner {folder} | {folders}\n{files}", { folder: "INBOX", folders: ["INBOX", "/x/y"], files: ["INBOX/a.md", "/x/y/b.pdf"] });
  assert.equal(out, "Ordner INBOX | INBOX, /x/y\n- INBOX/a.md\n- /x/y/b.pdf");
  assert.equal(fillPrompt("{files}", { folder: "I", folders: ["I"], files: [] }), "-");
  const many = fillPrompt("{files}", { folder: "I", folders: ["I"], files: Array.from({ length: 205 }, (_, i) => `f${i}`) });
  assert.match(many, /- … \(\+5\)$/);
  assert.equal(fillPrompt("/inbox", { folder: "I", folders: ["I"], files: ["a"] }), "/inbox");
});

test("folders: home folder, comments, empty lines", () => {
  assert.deepEqual(parseFolders("~/A\n\n# x\n /abs/B \n"), [path.join(os.homedir(), "A"), "/abs/B"]);
});

test("ignored names", () => {
  for (const n of [".DS_Store", "index.md", "~$doc.docx", "a.crdownload", "Icon\r"]) assert.equal(ignoredName(n), true, n);
  for (const n of ["Rechnung.pdf", "notiz.md"]) assert.equal(ignoredName(n), false, n);
});

test("files outside the vault: recursive, hidden ones left out", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.pdf"), "x");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.jpg"), "x");
  const files = (await diskFiles(dir)).map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(files, ["a.pdf", path.join("sub", "b.jpg")]);
  assert.deepEqual(await diskFiles(path.join(dir, "missing")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("session phase", () => {
  const t0 = 1000;
  assert.equal(sessionPhase(null, t0, true), "idle");
  assert.equal(sessionPhase({}, t0, false), "idle");
  assert.equal(sessionPhase({}, t0, true), "running");
  assert.equal(sessionPhase({ agentState: "busy" }, t0, true), "running");
  assert.equal(sessionPhase({ agentState: "waiting" }, t0, true), "waiting");
  assert.equal(sessionPhase({ agentState: "done", stateAt: 500 }, t0, true), "running"); // left over from before
  assert.equal(sessionPhase({ agentState: "done", stateAt: 2000 }, t0, true), "finished");
  assert.equal(sessionPhase({ exited: true, agentState: "busy" }, t0, true), "failed");
  assert.equal(sessionPhase({ exited: true, agentState: "done" }, t0, true), "finished");
});
