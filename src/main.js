// Sidecar Agent – real terminal sessions for Claude Code and Antigravity in the right sidebar
// (top: sessions and search, middle: terminal, bottom: info and actions), with renaming,
// per-session model and effort, parallel sessions, a reading view and usage limits.
import { Events, FileSystemAdapter, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import fs from "fs";
import os from "os";
import path from "path";
import { SessionStore } from "./store";
import STATUSLINE_PY from "./py/statusline.py";
import CONTEXT_HOOK_PY from "./py/context_hook.py";
import { AgentPanelView, VIEW_PANEL } from "./panel-view";
import { isDarkTheme, obsidianAccent } from "./session";
import { ConfirmModal, EFFORTS, NewSessionModal, TextModal } from "./modals";
import { SidecarSettingTab, DEFAULT_SETTINGS } from "./settings";
import { AGY_DB, CACHE_DIR, SUPPORT_DIR, mention, resolveBin, run, uuid, newestFlashModel, vaultHash } from "./util";
import { t, setLanguage } from "./i18n";

const THEME_NAME = "sidecar-agent";

export default class SidecarAgentPlugin extends Plugin {
  async onload() {
    this.bus = new Events(); // event "terminals-changed"
    await this.loadSettings();
    setLanguage(this.settings.language);
    this.applyReaderStyle();
    const ad = this.app.vault.adapter;
    if (!(ad instanceof FileSystemAdapter)) {
      new Notice(t("notice.desktopOnly"));
      return;
    }
    this.vaultPath = ad.getBasePath();
    this.ctxFile = path.join(CACHE_DIR, `context-${vaultHash(this.vaultPath)}.json`);
    this.terminals = new Set();
    this.activeTerminal = null;
    this.store = new SessionStore(this);

    this.registerView(VIEW_PANEL, (leaf) => new AgentPanelView(leaf, this));
    this.addSettingTab(new SidecarSettingTab(this.app, this));
    this.addRibbonIcon("messages-square", t("ribbon.open"), () => this.activatePanel(true));

    this.addCommand({ id: "open-panel", name: t("cmd.openPanel"), callback: () => this.activatePanel(true) });
    this.addCommand({ id: "search", name: t("cmd.search"), callback: async () => (await this.activatePanel(true))?.focusSearch() });
    this.addCommand({ id: "focus-terminal", name: t("cmd.focusTerminal"), callback: async () => (await this.activatePanel(true))?.focusInput() });
    this.addCommand({ id: "new-claude", name: t("cmd.newClaude"), callback: () => this.startNew({ agent: "claude" }) });
    this.addCommand({ id: "new-agy", name: t("cmd.newAgy"), callback: () => this.startNew({ agent: "agy" }) });
    this.addCommand({ id: "new-with-options", name: t("cmd.newOptions"), callback: () => this.openNewSessionModal({}) });
    this.addCommand({
      id: "send-note",
      name: t("cmd.sendNote"),
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) this.sendNote(f.path);
        return true;
      },
    });
    this.addCommand({
      id: "send-selection",
      name: t("cmd.sendSelection"),
      editorCheckCallback: (checking, editor, ctx) => {
        const sel = editor.getSelection();
        if (!sel) return false;
        if (!checking) this.sendSelection(sel, ctx.file?.path);
        return true;
      },
    });
    this.addCommand({
      id: "rename-active",
      name: t("cmd.rename"),
      checkCallback: (checking) => {
        const v = this.panel?.active;
        if (!v) return false;
        if (!checking) this.renameTerminal(v);
        return true;
      },
    });
    this.addCommand({
      id: "interrupt",
      name: t("cmd.interrupt"),
      checkCallback: (checking) => {
        const v = this.panel?.active;
        if (!v?.running) return false;
        if (!checking) v.interrupt();
        return true;
      },
    });
    this.addCommand({ id: "toggle-focus-lock", name: t("cmd.focusLock"), callback: () => this.toggleFocusLock() });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const sel = editor.getSelection();
        if (sel)
          menu.addItem((i) =>
            i
              .setTitle(t("menu.sendSelection"))
              .setIcon("send")
              .onClick(() => this.sendSelection(sel, info.file?.path)),
          );
        if (info.file)
          menu.addItem((i) =>
            i
              .setTitle(t("menu.sendNote"))
              .setIcon("at-sign")
              .onClick(() => this.sendNote(info.file.path)),
          );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!file?.path) return;
        menu.addItem((i) =>
          i
            .setTitle(t("menu.sendFile"))
            .setIcon("at-sign")
            .onClick(() => this.sendNote(file.path)),
        );
      }),
    );

    this.limits = { claude: null, agy: null };
    this.pending = new Map(); // scheduled resumes per session key
    this.registerInterval(window.setInterval(() => this.tickLimits(), 30000));
    this.setupFocusLock();
    this.registerEvent(this.app.workspace.on("css-change", () => this.writeClaudeTheme()));
    this.app.workspace.onLayoutReady(() => this.setupNoteContext());

    this.app.workspace.onLayoutReady(() => {
      // Read limits right away and shortly after start (not only on the first 30 s tick)
      this.tickLimits();
      window.setTimeout(() => this.tickLimits(), 5000);
      this.store.startWatching();
      this.store.refresh();
      // After a plugin reload Obsidian restores the existing panel a moment later; only create one if none comes back.
      if (this.settings.openPanelOnStart) {
        window.setTimeout(() => {
          if (!this.app.workspace.getLeavesOfType(VIEW_PANEL).length) this.activatePanel(false);
        }, 1500);
      }
    });
    this.register(() => this.store.stopWatching());
  }

  /** Always look the panel up in the workspace (a stored reference got lost when a second panel was closed). */
  get panel() {
    const leaf = this.app?.workspace?.getLeavesOfType(VIEW_PANEL).find((l) => l.view instanceof AgentPanelView);
    return leaf ? leaf.view : null;
  }

  on(name, cb) {
    return this.bus.on(name, cb);
  }
  trigger(name, ...args) {
    this.bus?.trigger(name, ...args);
  }

  onunload() {
    for (const v of this.terminals || []) v.kill();
    try {
      if (this.ctxFile) fs.writeFileSync(this.ctxFile, JSON.stringify({ enabled: false }));
    } catch {
      // nothing to clean up
    }
    document.body.setCssProps({ "--sa-reader-font": "", "--sa-reader-size": "", "--sa-reader-line": "" });
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.aliases = this.settings.aliases || {};
    this.settings.layout = Object.assign({}, DEFAULT_SETTINGS.layout, data.layout || {});
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------------------------------------------------------------- paths
  claudePath() {
    return resolveBin("claude", this.settings.claudePath);
  }
  agyPath() {
    return resolveBin("agy", this.settings.agyPath);
  }
  pythonPath() {
    return resolveBin("python3", this.settings.pythonPath);
  }
  rgPath() {
    return resolveBin("rg", this.settings.rgPath);
  }

  // ---------------------------------------------------------------- start commands
  /** Builds the program call from a session state. */
  buildCommand(st) {
    const s = this.settings;
    const args = [];
    let stateUpdate = null;
    let prompt = st.initialPrompt || "";
    if (st.notePath) prompt = [prompt, t("prompt.reference", { ref: mention(st.notePath) })].filter(Boolean).join("\n\n");

    if (st.agent === "claude") {
      const bin = this.claudePath();
      if (!bin) throw new Error(t("err.noClaude"));
      if (s.claudeRemoteControl === "on") args.push("--remote-control");
      // Plugin sessions only (--settings applies to this process): status line for the usage limits,
      // note-context hook, color scheme and auto-continue. The global Claude settings stay untouched.
      const extra = { autoContinueAtUsageLimit: true };
      const sl = this.writeHelperScript("statusline.py", STATUSLINE_PY);
      if (sl) extra.statusLine = { type: "command", command: sl, padding: 0 };
      // The hook is always installed; it reads the on/off switch from the context file at every message.
      const hook = this.writeHelperScript("context_hook.py", CONTEXT_HOOK_PY);
      if (hook) extra.hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: hook, timeout: 5 }] }] };
      if (s.claudeTheme === "ansi") extra.theme = this.writeClaudeTheme() || (isDarkTheme() ? "dark-ansi" : "light-ansi");
      args.push("--settings", JSON.stringify(extra));
      if (s.claudePermissionMode) args.push("--permission-mode", s.claudePermissionMode);
      if (st.model) args.push("--model", st.model);
      if (st.effort) args.push("--effort", st.effort);
      const name = st.name || this.settings.aliases[`claude:${st.sessionId}`];
      if (st.fork && st.forkFrom) {
        const id = uuid();
        args.push("--resume", st.forkFrom, "--fork-session", "--session-id", id);
        stateUpdate = { sessionId: id, fork: false, forkFrom: undefined, mode: "resume" };
      } else if (st.sessionId && this.store.claudeSessionExists(st.sessionId)) {
        args.push("--resume", st.sessionId);
      } else {
        const id = st.sessionId || uuid();
        args.push("--session-id", id);
        if (id !== st.sessionId) stateUpdate = { sessionId: id };
      }
      if (name) args.push("--name", name);
      if (prompt) args.push(prompt.startsWith("-") ? ` ${prompt}` : prompt);
      return { bin, args, stateUpdate };
    }
    if (st.agent === "agy") {
      const bin = this.agyPath();
      if (!bin) throw new Error(t("err.noAgy"));
      if (s.agyRemoteControl) args.push("--remote-control");
      if (s.agySkipPermissions) args.push("--dangerously-skip-permissions");
      // The default model applies to new conversations only. A resumed one keeps its model.
      const model = st.model || (st.sessionId ? "" : this.resolveAgyDefaultModel());
      if (model) args.push("--model", model);
      if (st.effort) args.push("--effort", st.effort);
      if (st.sessionId) args.push("--conversation", st.sessionId);
      if (prompt) args.push("--prompt-interactive", prompt);
      return { bin, args, stateUpdate };
    }
    throw new Error(t("err.unknownAgent", { agent: st.agent }));
  }

  /** Effective default model for Antigravity: the setting, "newest Flash", or agy's own default (""). */
  resolveAgyDefaultModel() {
    const v = this.settings.agyDefaultModel;
    if (v === "newest-flash") return newestFlashModel(this.settings.agyModelsCache?.models);
    return v || "";
  }

  async modelOptions(agent) {
    if (agent === "claude") {
      return this.settings.claudeModels
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((m) => [m, m]);
    }
    const c = this.settings.agyModelsCache;
    if (c && Date.now() - c.at < 7 * 86400000 && c.models.length) return c.models;
    const bin = this.agyPath();
    if (!bin) return [];
    try {
      const { stdout } = await run(bin, ["models"], { cwd: this.vaultPath, timeout: 30000 });
      const models = stdout
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length >= 2 && p[0].trim() && !p[0].startsWith("Fetching"))
        .map(([id, label]) => [id.trim(), label.trim()]);
      if (models.length) {
        this.settings.agyModelsCache = { at: Date.now(), models };
        await this.saveSettings();
      }
      return models;
    } catch (e) {
      console.warn("[sidecar-agent] agy models", e);
      return c?.models || [];
    }
  }

  // ---------------------------------------------------------------- Claude color scheme
  /**
   * Writes ~/.claude/themes/sidecar-agent.json: base dark-ansi/light-ansi (= the plugin's muted palette),
   * accent tokens in the Obsidian accent color. Returns "custom:sidecar-agent" (or null on error).
   */
  writeClaudeTheme() {
    if (this.settings.claudeTheme !== "ansi") return null;
    try {
      const accent = obsidianAccent();
      const theme = {
        name: "Obsidian (Sidecar Agent)",
        base: isDarkTheme() ? "dark-ansi" : "light-ansi",
        overrides: { claude: accent, claudeShimmer: accent, suggestion: accent, permission: accent },
      };
      const dir = path.join(os.homedir(), ".claude", "themes");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${THEME_NAME}.json`);
      const json = JSON.stringify(theme, null, 2) + "\n";
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== json) fs.writeFileSync(file, json);
      return `custom:${THEME_NAME}`;
    } catch (e) {
      console.warn("[sidecar-agent] color scheme", e);
      return null;
    }
  }

  // ---------------------------------------------------------------- helper scripts
  /** Puts a helper script for Claude (status line, hook) outside the vault and returns its command line. */
  writeHelperScript(name, content) {
    try {
      fs.mkdirSync(SUPPORT_DIR, { recursive: true });
      const file = path.join(SUPPORT_DIR, name);
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content);
      const py = this.pythonPath() || "/usr/bin/python3";
      return `'${py}' -I -B '${file}'`;
    } catch (e) {
      console.warn("[sidecar-agent] helper script", name, e);
      return null;
    }
  }

  /** Extra environment for agent processes: per-vault context file and the status line label. */
  agentEnv() {
    return { SIDECAR_AGENT_CONTEXT: this.ctxFile, SIDECAR_AGENT_WEEK_LABEL: t("limits.week") };
  }

  // ---------------------------------------------------------------- note context
  /** Remember the note on screen so the hook can append it to every Claude message. */
  setupNoteContext() {
    const update = () => {
      // The sidebar may have the focus (e.g. after a reload), so fall back to the last note in the main area
      const f = this.app.workspace.getActiveFile() || this.lastMarkdownView()?.file;
      if (f) this.ctxPath = f.path;
      this.ctxSel = "";
      this.writeNoteContext();
    };
    this.registerEvent(this.app.workspace.on("file-open", update));
    this.registerEvent(
      this.app.workspace.on("rename", (f, old) => {
        if (old !== this.ctxPath) return;
        this.ctxPath = f.path;
        this.writeNoteContext();
      }),
    );
    // Include the editor selection (debounced)
    let timer = null;
    this.registerDomEvent(document, "selectionchange", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const ed = this.app.workspace.activeEditor?.editor;
        const f = this.app.workspace.getActiveFile();
        if (!ed || !f) return;
        const sel = ed.getSelection() || "";
        if (f.path === this.ctxPath && sel === this.ctxSel) return;
        // Focus is in the terminal: keep the note's selection
        if (!sel && document.activeElement?.closest?.(".sidecar-agent-panel")) return;
        this.ctxPath = f.path;
        this.ctxSel = sel;
        this.writeNoteContext();
      }, 300);
    });
    update();
  }

  writeNoteContext() {
    try {
      fs.mkdirSync(path.dirname(this.ctxFile), { recursive: true });
      const data = { enabled: this.settings.noteContext !== false, path: this.ctxPath || "", selection: this.ctxSel || "", at: Date.now() };
      const tmp = this.ctxFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.ctxFile);
    } catch (e) {
      console.warn("[sidecar-agent] note context", e);
    }
    this.trigger("terminals-changed");
  }

  async toggleNoteContext() {
    this.settings.noteContext = this.settings.noteContext === false;
    await this.saveSettings();
    this.writeNoteContext();
  }

  // ---------------------------------------------------------------- usage limits and auto-continue
  /** Claude limits from the file the status line writes. */
  readClaudeLimits() {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "claude-limits.json"), "utf8"));
      const conv = (b) => (b ? { used: b.used_percentage, resetsAt: toMs(b.resets_at) } : null);
      this.limits.claude = { at: d.at, fiveHour: conv(d.rate_limits?.five_hour), week: conv(d.rate_limits?.seven_day) };
    } catch {
      // no limits known yet
    }
    return this.limits.claude;
  }

  /** Antigravity limits via `agy -p /usage` (uses no quota), at most every 5 minutes. */
  async refreshAgyLimits(force = false) {
    const cur = this.limits.agy;
    if (!force && cur && Date.now() - cur.at < 5 * 60000) return cur;
    if (this.agyLimitsRunning) return cur;
    const bin = this.agyPath();
    if (!bin) return cur;
    this.agyLimitsRunning = true;
    try {
      const { stdout } = await run(bin, ["-p", "/usage", "--output-format", "json"], { cwd: os.tmpdir(), timeout: 60000 });
      const groups = JSON.parse(stdout)?.command?.data?.groups || [];
      const g = {};
      for (const grp of groups) {
        const e = { name: grp.name };
        for (const b of grp.buckets || []) {
          const slot = b.window === "weekly" ? "week" : /5h|five/i.test(b.id + b.name) ? "fiveHour" : null;
          if (slot) e[slot] = { used: Math.round((1 - (b.remaining_fraction ?? 1)) * 100), resetsAt: Date.parse(b.reset_time) };
        }
        g[grp.name] = e;
      }
      this.limits.agy = { at: Date.now(), groups: g };
    } catch (e) {
      console.warn("[sidecar-agent] agy /usage", e);
    } finally {
      this.agyLimitsRunning = false;
    }
    this.trigger("terminals-changed");
    return this.limits.agy;
  }

  /** Model last chosen in Antigravity (agy keeps it in its settings.json, also after /model in the TUI). */
  agyCurrentModel() {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"), "utf8")).model || "";
    } catch {
      return "";
    }
  }

  /**
   * Limits that apply to a session: {fiveHour, week, label} or null.
   * Antigravity has separate quotas per model group ("Gemini Models", "Claude and GPT models", …).
   * Matching: the group name appears in the model name, otherwise Claude/GPT/OSS → Claude group,
   * otherwise the general Gemini group.
   */
  limitsFor(s) {
    if (s.st.agent === "claude") return this.limits.claude ? { ...this.limits.claude, label: t("limits.claudePlan") } : null;
    const g = this.limits.agy?.groups;
    if (!g) return null;
    const norm = (x) =>
      String(x || "")
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, "-");
    const m = norm(s.st.model || this.agyCurrentModel() || s.model());
    const names = Object.keys(g);
    let name = names.filter((k) => !/^gemini models$/i.test(k) && !/claude|gpt/i.test(k)).find((k) => m.includes(norm(k)));
    if (!name && /claude|gpt|oss/.test(m)) name = names.find((k) => /claude|gpt/i.test(k));
    if (!name) name = names.find((k) => /^gemini models$/i.test(k)) || names.find((k) => /gemini/i.test(k));
    return name ? { ...g[name], label: name } : null;
  }

  /** Every 30 s: refresh limits and check running Claude sessions for a usage limit. */
  tickLimits() {
    this.readClaudeLimits();
    if ([...this.terminals].some((s) => s.st.agent === "agy")) this.refreshAgyLimits();
    if (this.settings.autoResume) for (const s of this.terminals) if (s.st.agent === "claude" && s.running) this.checkUsageLimit(s);
    this.trigger("terminals-changed");
  }

  /**
   * With Remote Control active, Claude Code does not start its own wait after a usage limit.
   * So: detect the limit error at the end of the session file and send a resume message after the reset.
   */
  checkUsageLimit(s) {
    const key = s.key;
    if (!key || this.pending.has(key)) return;
    let tail;
    try {
      const f = path.join(this.store.paths.claudeDir, `${s.st.sessionId}.jsonl`);
      const fd = fs.openSync(f, "r");
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 400000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      tail = buf.toString("utf8").split("\n").filter(Boolean);
    } catch {
      return;
    }
    let idx = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i].includes('"apiError":"usage_limit_reached"')) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    let rec;
    try {
      rec = JSON.parse(tail[idx]);
    } catch {
      return;
    }
    // Already continued afterwards (new question or answer)? Then do nothing.
    for (let i = idx + 1; i < tail.length; i++) {
      try {
        const d = JSON.parse(tail[i]);
        if ((d.type === "user" && !d.isMeta) || (d.type === "assistant" && !d.isApiErrorMessage && !String(tail[i]).includes("usage_limit_reached"))) return;
      } catch {
        // incomplete line
      }
    }
    const limitAt = Date.parse(rec.timestamp) || Date.now();
    if (this.handledLimits?.has(`${key}@${limitAt}`)) return;
    const text = JSON.stringify(rec.message?.content || "");
    const weekly = /weekly/i.test(text);
    const lim = this.readClaudeLimits();
    let resetAt = weekly ? lim?.week?.resetsAt : lim?.fiveHour?.resetsAt;
    if (!resetAt || resetAt < limitAt) resetAt = parseResetText(text, limitAt);
    if (!resetAt) return;
    const at = Math.max(resetAt + 60000, Date.now() + 5000);
    const timer = window.setTimeout(() => this.resumeAfterLimit(s, key), at - Date.now());
    this.pending.set(key, { at, timer, limitAt });
    this.handledLimits = this.handledLimits || new Set();
    this.handledLimits.add(`${key}@${limitAt}`);
    this.trigger("terminals-changed");
  }

  cancelPending(s) {
    const p = this.pending.get(s.key);
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pending.delete(s.key);
    new Notice(t("notice.autoResumeCancelled"));
    this.trigger("terminals-changed");
  }

  async resumeAfterLimit(s, key) {
    this.pending.delete(key);
    this.trigger("terminals-changed");
    if (!this.terminals.has(s) || !s.running) return;
    if (await this.claudeBusy(s.st.sessionId)) return; // already working again
    s.submit(this.settings.autoResumeMessage || t("prompt.autoResume"));
    new Notice(t("notice.autoResumed", { title: s.title() }));
  }

  // ---------------------------------------------------------------- focus lock (voice input)
  /**
   * Keeps keyboard focus in the active session's terminal while "focusLock" is on: clicks into notes
   * or the workspace and returning from another app send the focus back. Ordinary input fields,
   * dialogs and menus stay usable.
   */
  setupFocusLock() {
    const focusTerm = () => {
      const s = this.panel?.active;
      if (!this.settings.focusLock) return;
      if (s?.reader?.el?.offsetParent) return s.reader.focusInput();
      if (!s?.term || !s.el?.offsetParent) return;
      s.term.focus();
    };
    this.registerDomEvent(
      document,
      "focusin",
      (ev) => {
        if (!this.settings.focusLock) return;
        const s = this.panel?.active;
        const target = ev.target;
        if (!s?.el || !(target instanceof HTMLElement) || s.el.contains(target) || s.reader?.el?.contains(target)) return;
        if (target.closest(".modal-container, .prompt, .menu, .suggestion-container, .popover, .mod-settings")) return;
        const isField = (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") && !target.closest(".xterm");
        if (isField) return;
        window.setTimeout(focusTerm, 0);
      },
      true,
    );
    this.registerDomEvent(window, "focus", () => window.setTimeout(focusTerm, 60));
  }

  async toggleFocusLock(on) {
    this.settings.focusLock = on === undefined ? !this.settings.focusLock : on;
    await this.saveSettings();
    new Notice(this.settings.focusLock ? t("notice.focusLockOn") : t("notice.focusLockOff"));
    if (this.settings.focusLock) {
      const a = this.panel?.active;
      if (a?.reader?.el?.offsetParent) a.reader.focusInput();
      else a?.term?.focus();
    }
    this.trigger("terminals-changed");
  }

  // ---------------------------------------------------------------- panel
  /** Get or create the panel in the right sidebar. */
  async activatePanel(reveal) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_PANEL)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_PANEL, active: !!reveal });
    }
    if (reveal || leaf.isDeferred) await ws.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    return leaf.view instanceof AgentPanelView ? leaf.view : null;
  }

  async openTerminal(state) {
    const panel = await this.activatePanel(true);
    if (!panel) return null;
    return panel.openSession(state);
  }

  saveLayoutSoon() {
    window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => this.app.workspace.requestSaveLayout(), 500);
  }

  openKeys() {
    const keys = new Set();
    for (const v of this.terminals) if (v.key) keys.add(v.key);
    return keys;
  }

  findTerminal(key) {
    for (const v of this.terminals) if (v.key === key) return v;
    return null;
  }

  async reveal(session) {
    const panel = await this.activatePanel(true);
    panel?.activate(session);
  }

  setActiveTerminal(v) {
    this.activeTerminal = v;
  }

  /** Reading view font as CSS variables on <body> (empty = like notes). */
  applyReaderStyle() {
    const s = this.settings;
    const fonts = { interface: "var(--font-interface)", monospace: "var(--font-monospace)", custom: s.readerFontCustom?.trim() ? `${s.readerFontCustom}, var(--font-text)` : "" };
    document.body.setCssProps({
      "--sa-reader-font": fonts[s.readerFont] || "",
      "--sa-reader-size": s.readerFontSize ? `${s.readerFontSize}px` : "",
      "--sa-reader-line": s.readerLineHeight ? String(s.readerLineHeight) : "",
    });
  }

  applyTerminalOptions() {
    for (const v of this.terminals) v.applyOptions();
  }

  // ---------------------------------------------------------------- actions
  startNew({ agent, ...rest }) {
    return this.openTerminal({ agent: agent || this.settings.defaultAgent, mode: "new", ...rest });
  }

  openNewSessionModal(opts) {
    new NewSessionModal(this, {
      ...opts,
      onSubmit: async (v) => {
        const st = {
          agent: v.agent,
          mode: "new",
          model: v.model || undefined,
          effort: v.effort || undefined,
          name: v.name || undefined,
          initialPrompt: v.initialPrompt || undefined,
          notePath: v.notePath,
        };
        const s = await this.openTerminal(st);
        if (v.name && s?.st?.sessionId) this.setAlias(`${v.agent}:${s.st.sessionId}`, v.name);
      },
    }).open();
  }

  async resume(e, { fork = false } = {}) {
    await this.activatePanel(true);
    if (!fork) {
      const open = this.findTerminal(e.key);
      if (open) return this.reveal(open);
    }
    if (fork) return this.openTerminal({ agent: "claude", mode: "new", fork: true, forkFrom: e.id });
    return this.openTerminal({ agent: e.agent, mode: "resume", sessionId: e.id });
  }

  resumeWithOptions(e) {
    const open = this.findTerminal(e.key);
    if (open) {
      new Notice(t("notice.alreadyOpen"));
      return this.reveal(open);
    }
    new NewSessionModal(this, {
      agent: e.agent,
      lockAgent: true,
      hideName: true,
      hidePrompt: true,
      title: t("modal.resumeTitle", { name: this.store.displayName(e) }),
      submitText: t("modal.resume"),
      onSubmit: (v) => this.openTerminal({ agent: e.agent, mode: "resume", sessionId: e.id, model: v.model || undefined, effort: v.effort || undefined }),
    }).open();
  }

  async setAlias(key, name) {
    if (name) this.settings.aliases[key] = name;
    else delete this.settings.aliases[key];
    await this.saveSettings();
    this.store.trigger("changed");
  }

  renameEntry(e) {
    new TextModal(this.app, {
      title: t("modal.renameTitle"),
      value: this.store.displayName(e),
      desc: e.agent === "claude" ? t("modal.renameClaudeDesc") : "",
      onSubmit: async (name) => {
        await this.store.rename(e, name);
        this.findTerminal(e.key)?.rename(name);
      },
    }).open();
  }

  renameTerminal(v) {
    const e = v.entry();
    new TextModal(this.app, {
      title: t("modal.renameTitle"),
      value: v.title(),
      onSubmit: async (name) => {
        v.rename(name);
        if (e) await this.store.rename(e, name);
        else if (v.key) await this.setAlias(v.key, name);
      },
    }).open();
  }

  // ---------------------------------------------------------------- switch model / effort
  /** Short display name (claude-opus-5-5 -> opus-5-5). */
  modelLabel(m) {
    return (m || "").replace(/^claude-/, "");
  }

  async claudeAgents() {
    const bin = this.claudePath();
    if (!bin) return [];
    try {
      const { stdout } = await run(bin, ["agents", "--json"], { cwd: this.vaultPath, timeout: 10000 });
      return JSON.parse(stdout) || [];
    } catch {
      return [];
    }
  }

  /** Is this Claude conversation currently open in another live process? (`claude agents --json`) */
  async claudeRunningElsewhere(sessionId) {
    if (!sessionId) return null;
    return (await this.claudeAgents()).find((x) => x.sessionId === sessionId && x.pid && x.kind !== "background") || null;
  }

  /** Is this Claude session producing an answer right now? */
  async claudeBusy(sessionId) {
    if (!sessionId) return false;
    return (await this.claudeAgents()).some((x) => x.sessionId === sessionId && x.status === "busy");
  }

  /**
   * Switch model/effort for this session only. Deliberately not via a typed `/model <name>` or
   * `/effort <level>`: Claude Code stores that as the new global default. Instead the session is
   * restarted with --resume/--conversation plus --model/--effort (the history is kept).
   */
  async switchModel(s, change) {
    const same = Object.keys(change).every((k) => (s.st[k] || "") === (change[k] || ""));
    if (same) return;
    const parts = [];
    if (change.model !== undefined) parts.push(t("switch.model", { value: change.model || t("common.default") }));
    if (change.effort !== undefined) parts.push(t("switch.effort", { value: change.effort || t("common.default") }));
    const label = parts.join(", ");
    if (!s.running) {
      Object.assign(s.st, change);
      s.changed();
      this.saveLayoutSoon();
      new Notice(t("notice.switchNextStart", { label }));
      return;
    }
    const busy = s.st.agent === "claude" ? await this.claudeBusy(s.st.sessionId) : false;
    if (busy) {
      const m = new ConfirmModal(this.app, {
        title: t("modal.busyTitle"),
        text: t("modal.busyText", { label }),
        ok: t("modal.busyOk"),
        cancel: t("modal.busyCancel"),
      });
      m.open();
      if (!(await m.result)) return;
    }
    Object.assign(s.st, change);
    s.term?.write(`\r\n\x1b[2m↻ ${t("term.switching", { label })}\x1b[0m\r\n`);
    s.kill();
    s.restart();
    s.changed();
    this.saveLayoutSoon();
  }

  /** Model menu. */
  async modelMenu(s, ev) {
    const m = new Menu();
    const cur = s.st.model || "";
    const models = await this.modelOptions(s.st.agent);
    const agyDefault = this.resolveAgyDefaultModel();
    const defLabel = s.st.agent === "claude" ? t("model.defaultClaude") : agyDefault ? `${t("common.default")} (${agyDefault})` : t("model.defaultAgy");
    m.addItem((i) =>
      i
        .setTitle(defLabel)
        .setChecked(!cur)
        .onClick(() => this.switchModel(s, { model: "" })),
    );
    for (const [id, label] of models)
      m.addItem((i) =>
        i
          .setTitle(label)
          .setChecked(cur === id)
          .onClick(() => this.switchModel(s, { model: id })),
      );
    m.addSeparator();
    m.addItem((i) => i.setTitle(t("model.onlyThisSession")).setDisabled(true));
    m.showAtMouseEvent(ev);
  }

  /** Effort menu. */
  effortMenu(s, ev) {
    const m = new Menu();
    const cur = s.st.effort || "";
    for (const id of EFFORTS)
      m.addItem((i) =>
        i
          .setTitle(id || t("common.default"))
          .setChecked(cur === id)
          .onClick(() => this.switchModel(s, { effort: id })),
      );
    m.addSeparator();
    m.addItem((i) => i.setTitle(t("model.onlyThisSession")).setDisabled(true));
    m.showAtMouseEvent(ev);
  }

  // ---------------------------------------------------------------- note context → prompt line
  async insertIntoTerminal(text, paste = false) {
    const panel = await this.activatePanel(true);
    panel?.insertIntoTerminal(text, paste);
  }

  sendNote(p) {
    return this.insertIntoTerminal(mention(p) + " ");
  }

  sendSelection(text, filePath) {
    const head = filePath ? `${t("prompt.excerpt", { ref: mention(filePath) })}\n` : "";
    return this.insertIntoTerminal(`${head}"""\n${text}\n"""\n`, true);
  }

  /** Most recent note in the main area (also when the sidebar has focus). */
  lastMarkdownView() {
    const ws = this.app.workspace;
    const leaf = ws.getMostRecentLeaf?.(ws.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view : ws.getActiveViewOfType(MarkdownView);
  }

  insertActiveNote() {
    const f = this.lastMarkdownView()?.file || this.app.workspace.getActiveFile();
    if (!f) return new Notice(t("notice.noNote"));
    this.sendNote(f.path);
  }

  insertActiveSelection() {
    const v = this.lastMarkdownView();
    const sel = v?.editor?.getSelection();
    if (!sel) return new Notice(t("notice.noSelection"));
    this.sendSelection(sel, v.file?.path);
  }

  /** Files from the file explorer or text via drag and drop. */
  handleDrop(ev, insert) {
    ev.preventDefault();
    const dm = this.app.dragManager?.draggable;
    const files = dm?.file ? [dm.file] : dm?.files || [];
    if (files.length) {
      insert(files.map((f) => mention(f.path)).join(" ") + " ");
      return;
    }
    const txt = ev.dataTransfer?.getData("text/plain");
    if (txt) insert(txt);
  }

  /** Antigravity has no --session-id: find the new conversation in its database after the start. */
  async detectAgyConversation(view) {
    const started = view.startedAt;
    const vaultUri = `file://${this.vaultPath}`;
    const claimed = () => new Set([...this.terminals].filter((v) => v !== view && v.st.agent === "agy").map((v) => v.st.sessionId));
    for (let i = 0; i < 300 && view.running && !view.st.sessionId; i++) {
      await new Promise((r) => window.setTimeout(r, 2000));
      if (!fs.existsSync(AGY_DB)) continue;
      try {
        const q =
          "select conversation_id, workspace_uris, last_user_input_time from conversation_summaries where parent_conversation_id='' order by last_user_input_time desc limit 10";
        const { stdout } = await run("/usr/bin/sqlite3", ["-readonly", "-separator", "\t", AGY_DB, q], { timeout: 5000 });
        const taken = claimed();
        for (const line of stdout.split("\n")) {
          const [id, ws, ts0] = line.split("\t");
          if (!id || taken.has(id) || !ws?.includes(`"${vaultUri}"`)) continue;
          const ts = Date.parse((ts0 || "").replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
          if (ts && ts >= started - 5000) {
            view.setSessionId(id);
            this.store.scheduleRefresh(1000);
            return;
          }
        }
      } catch (e) {
        console.warn("[sidecar-agent] agy detection", e);
      }
    }
  }
}

/** Timestamp (seconds, milliseconds or ISO) to milliseconds. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const ts = Date.parse(v);
  return Number.isNaN(ts) ? null : ts;
}

/** Turns "resets 4:20pm (Europe/Berlin)" or "resets Oct 24, 10am" into a time after limitAt. */
function parseResetText(text, limitAt) {
  const m = text.match(/resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") h += 12;
  const d = new Date(limitAt);
  if (m[1]) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
    if (mon >= 0) d.setMonth(mon, Number(m[2]));
  }
  d.setHours(h, Number(m[4] || 0), 0, 0);
  if (d.getTime() < limitAt) d.setDate(d.getDate() + 1);
  return d.getTime();
}
