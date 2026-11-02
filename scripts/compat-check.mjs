// Before a release: do the parsers still understand the sessions of the installed Claude Code and Antigravity?
// Claude Code's session format and hook names are not a stable API and change with its frequent updates.
// Checks the newest real sessions on this Mac (read-only, nothing leaves the machine) and the installed
// Claude binary. Exit code 1 on a failure; unknown record types are only reported.
//   node scripts/compat-check.mjs [--n 25]
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { agyTail, ingestLine } from "../src/transcript.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const N = Number(process.argv[process.argv.indexOf("--n") + 1]) || 25;
const HOME = os.homedir();
const fail = [];
const warn = [];

// Record types seen so far; a new one is no error but worth a look (new features may need support).
const KNOWN = new Set([
  "user", "assistant", "system", "attachment", "summary", "mode", "permission-mode", "bridge-session", "atis-latch",
  "file-history-snapshot", "api-request", "api-request-blob", "api-request-shape", "last-prompt", "ai-title",
  "custom-title", "tools-used", "queue-operation", "cost-state", "progress", "agent-name", "tag", "file-history-delta", "continued-in",
]);

// ---------------------------------------------------------------- Claude sessions
const projects = path.join(HOME, ".claude", "projects");
const files = fs.existsSync(projects)
  ? fs
      .readdirSync(projects)
      .flatMap((d) => {
        const dir = path.join(projects, d);
        if (!fs.statSync(dir).isDirectory()) return [];
        return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
      })
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs, s: fs.statSync(f).size }))
      .filter((x) => x.s > 50000) // real conversations, not one-line headless runs
      .sort((a, b) => b.m - a.m)
      .slice(0, N)
  : [];
if (!files.length) warn.push("no Claude sessions found, Claude check skipped");

const types = new Map();
let withTurns = 0;
let checked = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-compat-"));
for (const { f } of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const turns = [];
  let prompts = 0;
  for (const l of lines) {
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    types.set(d.type, (types.get(d.type) || 0) + 1);
    if (d.type === "user" && !d.isMeta && !d.isSidechain && typeof d.message?.content === "string" && !d.message.content.startsWith("<")) prompts++;
    ingestLine(turns, l);
  }
  checked++;
  if (prompts && turns.some((x) => x.role === "user") && turns.some((x) => x.role === "assistant")) withTurns++;
  else if (prompts && types.has("assistant")) fail.push(`reading view finds no turns in ${path.basename(f)} (${prompts} prompts)`);
  fs.symlinkSync(f, path.join(tmp, path.basename(f)));
}
for (const [ty, n] of types) if (ty && !KNOWN.has(ty)) warn.push(`unknown record type "${ty}" (${n}×)`);

// Indexer over the same files
if (files.length) {
  const py = ["/opt/homebrew/bin/python3", "/usr/bin/python3"].find((p) => fs.existsSync(p));
  const vault = "/"; // any absolute path counts as inside, enough to see that tool paths are still found
  const r = spawnSync(py, ["-I", "-B", path.join(ROOT, "src/py/indexer.py"), JSON.stringify({ mode: "index", vault, claudeDir: tmp, agyDb: "", cache: path.join(tmp, "cache.json") })], { encoding: "utf8" });
  if (r.status !== 0) fail.push(`indexer failed: ${r.stderr.slice(0, 300)}`);
  else {
    const idx = JSON.parse(r.stdout).claude;
    const real = idx.filter((c) => c.userMessages > 0);
    if (!real.length) fail.push("indexer finds no prompts in any session");
    const noTitle = real.filter((c) => !c.firstPrompt && !c.customTitle && !c.aiTitle);
    if (noTitle.length) fail.push(`indexer: ${noTitle.length} sessions without any title or first prompt`);
    const noModel = real.filter((c) => !c.model);
    if (noModel.length > real.length / 2) fail.push(`indexer: model missing in ${noModel.length}/${real.length} sessions`);
    const noTs = real.filter((c) => !c.created);
    if (noTs.length) fail.push(`indexer: ${noTs.length} sessions without a start time`);
    const tools = real.filter((c) => c.files.length);
    if (real.length >= 5 && !tools.length) warn.push("indexer: no session with touched files (format of tool calls changed?)");
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------- Claude binary: hook events and copy
const bin = ["~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map((p) => p.replace("~", HOME)).find((p) => fs.existsSync(p));
let version = "?";
if (bin) {
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 20000 }).trim();
  } catch {
    // keep "?"
  }
  const real = fs.realpathSync(bin);
  const data = fs.readFileSync(real).toString("latin1");
  for (const ev of ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop", "StopFailure", "Notification", "SessionStart"])
    if (!data.includes(`"${ev}"`)) fail.push(`Claude Code ${version}: hook event ${ev} not found`);
  for (const k of ["permission_prompt", "idle_prompt", "last_assistant_message", "context_window_size", "used_percentage"])
    if (!data.includes(k)) fail.push(`Claude Code ${version}: "${k}" not found (hook or status line input changed?)`);
  if (!data.includes("Now using usage credits")) warn.push(`Claude Code ${version}: usage credits message changed, the warning may not appear`);
  if (!data.includes("Jump to bottom")) warn.push(`Claude Code ${version}: "Jump to bottom" hint changed, the jump-to-top button may not appear`);
} else warn.push("claude not found, binary check skipped");

// ---------------------------------------------------------------- Antigravity transcripts
const brain = path.join(HOME, ".gemini", "antigravity-cli", "brain");
let agyChecked = 0;
if (fs.existsSync(brain)) {
  const tr = fs
    .readdirSync(brain)
    .map((id) => path.join(brain, id, ".system_generated", "logs", "transcript.jsonl"))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 10);
  for (const { f } of tr) {
    const text = fs.readFileSync(f, "utf8");
    if (!text.includes("PLANNER_RESPONSE")) continue;
    agyChecked++;
    const r = agyTail(text.slice(-256 * 1024));
    if (!r || !r.used_tokens) fail.push(`Antigravity: no token count in ${path.basename(path.dirname(path.dirname(path.dirname(f))))}`);
  }
}

console.log(`Claude Code ${version}: ${checked} sessions checked, ${withTurns} with turns. Antigravity: ${agyChecked} transcripts.`);
for (const w of warn) console.log(`⚠️  ${w}`);
for (const f of fail) console.log(`❌ ${f}`);
if (fail.length) process.exit(1);
console.log("compat ok");
