// Sidecar Agent – logic of the task buttons without Obsidian: inbox file lists, time window, message
// placeholders and the phase of a tracked session.
import fs from "fs";
import os from "os";
import path from "path";

export const MAX_FILES = 200; // files listed in {files}
const SCAN_LIMIT = 2000; // entries read per outside folder
const IGNORED = new Set(["index.md", "desktop.ini", "Thumbs.db", "Icon\r"]);

/** Whether a name is left out: hidden files, system files, unfinished downloads. */
export function ignoredName(name) {
  return name.startsWith(".") || name.startsWith("~$") || IGNORED.has(name) || /\.(tmp|part|crdownload|download)$/i.test(name);
}

/** Files below a folder outside the vault, as absolute paths (at most SCAN_LIMIT entries, 6 levels). */
export async function diskFiles(dir, depth = 0, out = []) {
  if (depth > 6 || out.length >= SCAN_LIMIT) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= SCAN_LIMIT) break;
    if (ignoredName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await diskFiles(p, depth + 1, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** "~/x" → home folder; empty lines and comments (#) are left out. */
export function parseFolders(text) {
  return String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"))
    .map((x) => (x === "~" || x.startsWith("~/") ? path.join(os.homedir(), x.slice(1)) : x));
}

/** "08:00-20:00" → is `d` inside? Empty or invalid = always. A window may run past midnight. */
export function inHours(spec, d = new Date()) {
  const m = String(spec || "").match(/^\s*(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?\s*$/);
  if (!m) return true;
  const from = Number(m[1]) * 60 + Number(m[2] || 0);
  const to = Number(m[3]) * 60 + Number(m[4] || 0);
  const now = d.getHours() * 60 + d.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** The message: the setting (or the built-in default) with {folder}, {folders} and {files} filled in. */
export function fillPrompt(template, { folder, folders, files }) {
  let list = files.slice(0, MAX_FILES).map((f) => `- ${f}`);
  if (files.length > MAX_FILES) list.push(`- … (+${files.length - MAX_FILES})`);
  return template
    .split("{folder}")
    .join(folder)
    .split("{folders}")
    .join(folders.join(", "))
    .split("{files}")
    .join(list.join("\n") || "-");
}

/**
 * Phase of a tracked session. `startedAt` keeps a "done" left over from an earlier turn from counting.
 * Returns "idle" (no session or closed), "running", "waiting", "finished" (turn over) or "failed" (ended early).
 */
export function sessionPhase(s, startedAt, open) {
  if (!s || !open) return "idle";
  if (s.exited) return s.agentState === "done" ? "finished" : "failed";
  if (s.agentState === "waiting") return "waiting";
  if (s.agentState === "done" && (s.stateAt || 0) >= startedAt) return "finished";
  return "running";
}
