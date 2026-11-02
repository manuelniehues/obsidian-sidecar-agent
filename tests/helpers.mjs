// Shared helpers for the tests: paths, a temporary folder, running the Python helpers.
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const FIX = path.join(ROOT, "tests", "fixtures");
export const PY = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].find((p) => fs.existsSync(p)) || "python3";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-agent-test-"));
}

/** Runs src/py/<name> like the plugin does (-I -B, nothing written next to the script). */
export function runPy(name, { args = [], stdin = "", env = {} } = {}) {
  const r = spawnSync(PY, ["-I", "-B", path.join(ROOT, "src", "py", name), ...args], {
    input: stdin,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${name} exit ${r.status}: ${r.stderr}`);
  return r;
}

/** Fresh Antigravity database from the SQL fixture. */
export function agyDb(dir) {
  const db = path.join(dir, "conversation_summaries.db");
  fs.rmSync(db, { force: true });
  execFileSync("/usr/bin/sqlite3", [db], { input: fs.readFileSync(path.join(FIX, "agy", "summaries.sql"), "utf8") });
  fs.cpSync(path.join(FIX, "agy", "brain"), path.join(dir, "brain"), { recursive: true });
  return db;
}
