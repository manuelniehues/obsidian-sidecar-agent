// Sidecar Agent – helpers (paths, environment, processes, formatting)
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { t, locale } from "./i18n";

export const HOME = os.homedir();

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

export function firstExisting(list) {
  for (const p of list) {
    const x = expandHome(p);
    if (x && fs.existsSync(x)) return x;
  }
  return null;
}

/** Looks for a program in the usual install locations (Obsidian runs with a narrow PATH). */
export function resolveBin(name, configured) {
  return firstExisting([configured, `~/.local/bin/${name}`, `~/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]);
}

/** Claude Code stores sessions in ~/.claude/projects/<cwd with "-" for special characters>/. */
export function claudeProjectDir(cwd) {
  return path.join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export const AGY_DIR = path.join(HOME, ".gemini", "antigravity-cli");
export const AGY_DB = path.join(AGY_DIR, "conversation_summaries.db");
/** Everything the plugin writes lives in these two folders (plus the Claude theme file). */
export const CACHE_DIR = path.join(HOME, "Library", "Caches", "sidecar-agent");
export const SUPPORT_DIR = path.join(HOME, "Library", "Application Support", "sidecar-agent");

/** Short, stable id of a vault path (for per-vault files outside the vault). */
export function vaultHash(vaultPath) {
  return crypto.createHash("sha1").update(vaultPath).digest("hex").slice(0, 10);
}

/** Environment for the agents: strip Electron and nested Claude variables, ensure UTF-8 and colors. */
export function buildEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ELECTRON_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_AGENT_SDK_VERSION") {
      delete env[k];
    }
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (!env.LANG || !/UTF-8/i.test(env.LANG)) env.LANG = "en_US.UTF-8";
  if (!env.LC_CTYPE) env.LC_CTYPE = "en_US.UTF-8";
  const dirs = [path.join(HOME, ".local/bin"), path.join(HOME, "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  const cur = (env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  env.PATH = [...dirs.filter((p) => !cur.includes(p)), ...cur].join(":");
  env.HOME = env.HOME || HOME;
  return { ...env, ...extra };
}

export function uuid() {
  return crypto.randomUUID();
}

export function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 256 * 1024 * 1024, env: buildEnv(), ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

export function hhmm(ms) {
  return new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

export function relTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const hm = hhmm(ms);
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("time.yesterdayAt", { time: hm });
  const opts = d.getFullYear() === now.getFullYear() ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "2-digit" };
  return `${d.toLocaleDateString(locale(), opts)} ${hm}`;
}

export function dayBucket(ms) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ms >= start) return t("time.today");
  if (ms >= start - day) return t("time.yesterday");
  if (ms >= start - 6 * day) return t("time.last7");
  if (ms >= start - 29 * day) return t("time.last30");
  return new Date(ms).toLocaleDateString(locale(), { month: "long", year: "numeric" });
}

/** File mention in Claude Code syntax (@path, quoted when it contains spaces). */
export function mention(p) {
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

export const PLUGIN_NAME = "Sidecar Agent";

export const AGENTS = {
  claude: { label: "Claude Code", short: "Claude", icon: "sparkles" },
  agy: { label: "Antigravity", short: "Antigravity", icon: "orbit" },
};

/** Picks the newest Flash model from a model list ([[id, label], ...]); "" if there is none. */
export function newestFlashModel(models) {
  const flash = (models || []).map(([id]) => id).filter((id) => /flash/i.test(id));
  if (!flash.length) return "";
  const score = (id) => {
    const m = id.match(/(\d+(?:\.\d+)?)/);
    const ver = m ? parseFloat(m[1]) : 0;
    const effortWeight = id.endsWith("-high") ? 3 : id.endsWith("-medium") ? 2 : 1;
    return ver * 10 + effortWeight;
  };
  flash.sort((a, b) => score(b) - score(a));
  return flash[0];
}
