// Sidecar Agent – session index (Claude Code and Antigravity sessions of this vault)
import fs from "fs";
import os from "os";
import path from "path";
import { Events } from "obsidian";
import INDEXER from "./py/indexer.py";
import { AGY_DB, CACHE_DIR, claudeProjectDir, run, vaultHash } from "./util";
import { t } from "./i18n";

export class SessionStore extends Events {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.sessions = [];
    this.byKey = new Map();
    this.loaded = false;
    this.refreshing = null;
    this.pendingRefresh = false;
    this.watchers = [];
    this.watchTimer = null;
  }

  get paths() {
    const vault = this.plugin.vaultPath;
    return {
      vault,
      claudeDir: claudeProjectDir(vault),
      agyDb: AGY_DB,
      cache: path.join(CACHE_DIR, `index-${vaultHash(vault)}.json`),
    };
  }

  async python(args) {
    const py = this.plugin.pythonPath();
    if (!py) throw new Error(t("err.noPython"));
    const { stdout } = await run(py, ["-I", "-B", "-c", INDEXER, JSON.stringify(args)], { cwd: os.tmpdir() });
    return JSON.parse(stdout);
  }

  /** Rebuild the index. Concurrent calls are coalesced. */
  async refresh() {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        const raw = await this.python({ mode: "index", ...this.paths });
        this.merge(raw);
        this.loaded = true;
        this.trigger("changed");
      } catch (e) {
        console.error("[sidecar-agent] index failed", e, e.stderr);
        this.trigger("error", e);
      } finally {
        this.refreshing = null;
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          window.setTimeout(() => this.refresh(), 500);
        }
      }
    })();
    return this.refreshing;
  }

  merge(raw) {
    const out = [];
    for (const c of raw.claude || []) {
      if (!c.userMessages && !c.customTitle) continue; // title-only or background leftovers
      out.push({
        key: `claude:${c.id}`,
        agent: "claude",
        id: c.id,
        created: c.created,
        updated: c.updated,
        model: c.model,
        firstPrompt: c.firstPrompt,
        lastPrompt: c.lastPrompt,
        customTitle: c.customTitle,
        aiTitle: c.aiTitle,
        messages: c.userMessages,
      });
    }
    for (const a of raw.agy || []) {
      out.push({
        key: `agy:${a.id}`,
        agent: "agy",
        id: a.id,
        created: a.lastInput || a.updated,
        updated: a.updated,
        model: "",
        title: a.title,
        firstPrompt: a.preview,
        messages: a.steps,
      });
    }
    out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    this.sessions = out;
    this.byKey = new Map(out.map((e) => [e.key, e]));
  }

  find(agent, id) {
    if (!id) return null;
    return this.byKey.get(`${agent}:${id}`) || null;
  }

  displayName(e) {
    const al = this.plugin.settings.aliases || {};
    return al[e.key] || e.customTitle || e.aiTitle || e.title || (e.firstPrompt || "").slice(0, 90) || t("session.untitled");
  }

  /** Quick search across title, first/last prompt and model. */
  matches(e, q) {
    if (!q) return true;
    const hay = [this.displayName(e), e.firstPrompt, e.lastPrompt, e.aiTitle, e.title, e.model, e.id].filter(Boolean).join(" \u0001 ").toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  }

  /** Full-text search across all session files (ripgrep or the Antigravity FTS index). */
  async fulltext(q) {
    const res = await this.python({ mode: "search", query: q, rg: this.plugin.rgPath(), ...this.paths });
    const keys = new Set();
    for (const id of res.claude || []) keys.add(`claude:${id}`);
    for (const id of res.agy || []) keys.add(`agy:${id}`);
    return keys;
  }

  async rename(e, name) {
    const s = this.plugin.settings;
    s.aliases = s.aliases || {};
    if (name) s.aliases[e.key] = name;
    else delete s.aliases[e.key];
    await this.plugin.saveSettings();
    // Let Claude know the name too (resume list, prompt line), exactly like /rename.
    if (e.agent === "claude" && name) {
      const f = path.join(this.paths.claudeDir, `${e.id}.jsonl`);
      if (fs.existsSync(f)) {
        fs.appendFileSync(f, JSON.stringify({ type: "custom-title", customTitle: name, sessionId: e.id }) + "\n");
        e.customTitle = name;
      }
    }
    this.trigger("changed");
  }

  claudeSessionExists(id) {
    return !!id && fs.existsSync(path.join(this.paths.claudeDir, `${id}.jsonl`));
  }

  /** Watch the session folders and refresh the index with a delay. */
  startWatching() {
    this.stopWatching();
    for (const d of [this.paths.claudeDir, path.dirname(AGY_DB)]) {
      try {
        if (!fs.existsSync(d)) continue;
        this.watchers.push(fs.watch(d, { persistent: false }, () => this.scheduleRefresh()));
      } catch (e) {
        console.warn("[sidecar-agent] watch", d, e);
      }
    }
  }

  scheduleRefresh(delay = 8000) {
    if (this.watchTimer) return;
    this.watchTimer = window.setTimeout(() => {
      this.watchTimer = null;
      this.refresh();
    }, delay);
  }

  stopWatching() {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    if (this.watchTimer) window.clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }
}
