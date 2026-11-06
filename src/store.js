// Sidecar Agent – session index (Claude Code and Antigravity sessions of this vault)
import fs from "fs";
import os from "os";
import path from "path";
import { Events } from "obsidian";
import INDEXER from "./py/indexer.py";
import { AGY_DB, CACHE_DIR, agyLastConversation, claudeProjectDir, run, vaultHash } from "./util";
import { t } from "./i18n";
import { touchesFile } from "./transcript";

export class SessionStore extends Events {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.sessions = []; // what the list shows: this device's sessions plus chat notes of other devices
    this.local = []; // only this device's sessions
    this.noteOf = new Map(); // session key -> chat note in the vault
    this.byKey = new Map();
    this.loaded = false;
    this.refreshing = null;
    this.pendingRefresh = false;
    this.watchers = [];
    this.watchTimer = null;
  }

  /** Antigravity conversations of this vault that agy stored without a working folder. */
  agyIds() {
    return [...(this.plugin.settings.agyIds || []), agyLastConversation(this.plugin.vaultPath)].filter(Boolean);
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

  async python(args, script = INDEXER) {
    const py = this.plugin.pythonPath();
    if (!py) throw new Error(t("err.noPython"));
    const { stdout } = await run(py, ["-I", "-B", "-c", script, JSON.stringify(args)], { cwd: os.tmpdir() });
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
        const raw = await this.python({ mode: "index", ...this.paths, agyIds: this.agyIds() });
        this.merge(raw);
        this.loaded = true;
        this.plugin.archive.dirty = true;
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
        files: c.files || [],
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
        files: a.files || [],
      });
    }
    this.local = out;
    this.combine();
  }

  combine() {
    const { list, noteOf } = this.plugin.archive.entries(new Set(this.local.map((e) => e.key)));
    this.noteOf = noteOf;
    this.sessions = [...this.local, ...list].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    this.byKey = new Map(this.sessions.map((e) => [e.key, e]));
  }

  /** The chat notes changed: update the list without reading the session files. */
  rebuild() {
    if (!this.loaded) return;
    this.combine();
    this.trigger("changed");
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

  /** Did this session read or edit the vault file (see touchesFile)? */
  touches(e, filePath) {
    return touchesFile(e.files, filePath);
  }

  /** Full-text search across all session files (ripgrep or the Antigravity FTS index). */
  async fulltext(q) {
    const archive = this.plugin.archive;
    const res = await this.python({ mode: "search", query: q, rg: this.plugin.rgPath(), archiveDir: archive.enabled ? archive.folderAbs : "", ...this.paths });
    const keys = new Set();
    for (const id of res.claude || []) keys.add(`claude:${id}`);
    for (const id of res.agy || []) keys.add(`agy:${id}`);
    for (const id of res.archive || []) keys.add(`note:${id}`);
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
