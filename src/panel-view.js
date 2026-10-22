// Sidecar Agent – sidebar panel: sessions and search on top, terminal in the middle, info and actions below.
import { ItemView, Menu, setIcon } from "obsidian";
import { TerminalSession } from "./session";
import { SessionReader } from "./reader";
import { AGENTS, PLUGIN_NAME, dayBucket, hhmm, relTime } from "./util";
import { t, locale } from "./i18n";

export const VIEW_PANEL = "sidecar-agent-panel";

const FILTERS = ["all", "open", "claude", "agy"];
const PAGE = 150;

function iconBtn(parent, icon, label, onClick, cls = "") {
  const b = parent.createEl("button", { cls: `sa-icon-btn clickable-icon ${cls}`, attr: { "aria-label": label } });
  setIcon(b, icon);
  b.onclick = (ev) => {
    ev.stopPropagation();
    onClick(ev);
  };
  return b;
}

export class AgentPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sessions = [];
    this.active = null;
    this.query = "";
    this.filter = "all";
    this.fulltext = false;
    this.ftKeys = null;
    this.limit = PAGE;
    this.ftSeq = 0;
    this.restoreState = null;
  }

  getViewType() {
    return VIEW_PANEL;
  }
  getDisplayText() {
    return PLUGIN_NAME;
  }
  getIcon() {
    return "messages-square";
  }

  // ------------------------------------------------------------------ state
  getState() {
    const sessions = this.sessions.map((s) => s.saveState());
    return { sessions, active: Math.max(0, this.sessions.indexOf(this.active)) };
  }

  async setState(state, result) {
    await super.setState(state, result);
    if (state?.sessions?.length && !this.sessions.length) {
      if (this.built) this.restoreSessions(state);
      else this.restoreState = state;
    }
  }

  restoreSessions(state) {
    for (const st of state.sessions) this.addSession(new TerminalSession(this.plugin, st), false);
    const a = this.sessions[state.active || 0] || this.sessions[0];
    if (a) this.activate(a);
  }

  // ------------------------------------------------------------------ layout
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("sidecar-agent-panel");
    const lay = this.plugin.settings.layout;

    // ---- top: sessions
    this.topEl = root.createDiv({ cls: "sa-top" });
    const bar = this.topEl.createDiv({ cls: "sa-toolbar" });
    this.collapseBtn = iconBtn(bar, lay.topCollapsed ? "chevron-right" : "chevron-down", t("panel.toggleList"), () => this.toggleTop());
    const mk = (icon, text, label, fn, cls = "") => {
      const b = bar.createEl("button", { cls: `sa-btn ${cls}`, attr: { "aria-label": label } });
      setIcon(b.createSpan({ cls: "sa-btn-icon" }), icon);
      if (text) b.createSpan({ text });
      b.onclick = fn;
      return b;
    };
    mk(AGENTS.claude.icon, "Claude", t("cmd.newClaude"), () => this.plugin.startNew({ agent: "claude" }), "mod-cta");
    mk(AGENTS.agy.icon, "Antigravity", t("cmd.newAgy"), () => this.plugin.startNew({ agent: "agy" }));
    bar.createDiv({ cls: "sa-spacer" });
    iconBtn(bar, "sliders-horizontal", t("panel.newWithOptions"), () => this.plugin.openNewSessionModal({}));
    iconBtn(bar, "refresh-cw", t("panel.reload"), () => this.plugin.store.refresh());

    const search = this.topEl.createDiv({ cls: "sa-search" });
    this.searchInput = search.createEl("input", { type: "search", placeholder: t("panel.searchPlaceholder") });
    this.searchInput.oninput = () => {
      this.query = this.searchInput.value.trim();
      this.limit = PAGE;
      this.ftKeys = null;
      if (this.plugin.settings.layout.topCollapsed && this.query) this.toggleTop(false);
      this.renderList();
      if (this.fulltext) this.scheduleFulltext();
    };
    const ft = search.createEl("label", { cls: "sa-ft", attr: { "aria-label": t("panel.fulltextTip") } });
    const cb = ft.createEl("input", { type: "checkbox" });
    ft.appendText(t("panel.fulltext"));
    cb.onchange = () => {
      this.fulltext = cb.checked;
      this.ftKeys = null;
      if (this.fulltext) this.scheduleFulltext();
      else this.renderList();
    };

    this.listWrap = this.topEl.createDiv({ cls: "sa-list-wrap" });
    const chips = this.listWrap.createDiv({ cls: "sa-chips" });
    this.chipEls = {};
    for (const id of FILTERS) {
      const c = chips.createEl("button", { cls: "sa-chip", text: t(`filter.${id}`) });
      if (id === "open") c.setAttr("aria-label", t("filter.openTip"));
      c.onclick = () => {
        this.filter = id;
        this.limit = PAGE;
        this.renderList();
      };
      this.chipEls[id] = c;
    }
    this.status = this.listWrap.createDiv({ cls: "sa-status" });
    this.listEl = this.listWrap.createDiv({ cls: "sa-list" });

    this.split1 = root.createDiv({ cls: "sa-split", attr: { "aria-label": t("panel.dragToResize") } });

    // ---- middle: open sessions + terminal
    this.tabsEl = root.createDiv({ cls: "sa-tabs" });
    this.termArea = root.createDiv({ cls: "sa-term-area" });
    this.emptyEl = this.termArea.createDiv({ cls: "sa-empty" });
    this.emptyEl.createDiv({ text: t("panel.empty") });
    this.emptyEl.createDiv({ cls: "sa-empty-hint", text: t("panel.emptyHint") });

    // ---- bottom: info + actions (typing happens directly in the terminal's prompt line)
    this.bottomEl = root.createDiv({ cls: "sa-bottom" });
    this.infoEl = this.bottomEl.createDiv({ cls: "sa-info" });
    const act = this.bottomEl.createDiv({ cls: "sa-actions" });
    const mkA = (icon, text, label, fn) => {
      const b = act.createEl("button", { cls: "sa-btn", attr: { "aria-label": label } });
      setIcon(b.createSpan({ cls: "sa-btn-icon" }), icon);
      if (text) b.createSpan({ text });
      b.onclick = fn;
      return b;
    };
    mkA("at-sign", t("panel.note"), t("panel.noteTip"), () => this.plugin.insertActiveNote());
    mkA("text-select", t("panel.selection"), t("panel.selectionTip"), () => this.plugin.insertActiveSelection());
    mkA("square", t("panel.stop"), t("cmd.interrupt"), () => this.active?.interrupt());

    this.applyLayout();
    this.initSplitter(this.split1);

    this.registerEvent(this.plugin.store.on("changed", () => this.renderAll()));
    this.registerEvent(this.plugin.store.on("error", (e) => this.setStatus(`⚠️ ${t("panel.indexError", { msg: e.message })}`)));
    this.registerEvent(this.plugin.on("terminals-changed", () => this.renderAll()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.sessions.forEach((s) => s.applyOptions())));

    this.built = true;
    if (this.restoreState) {
      this.restoreSessions(this.restoreState);
      this.restoreState = null;
    }
    this.renderAll();
    if (!this.plugin.store.loaded) {
      this.setStatus(t("panel.loading"));
      this.plugin.store.refresh();
    }
  }

  async onClose() {
    for (const s of this.sessions) {
      s.reader?.dispose();
      s.dispose();
      this.plugin.terminals.delete(s);
    }
    this.sessions = [];
    this.active = null;
    this.plugin.trigger("terminals-changed");
  }

  // ------------------------------------------------------------------ layout
  applyLayout() {
    const lay = this.plugin.settings.layout;
    this.listWrap.toggle(!lay.topCollapsed);
    this.split1.toggle(!lay.topCollapsed);
    this.topEl.setCssStyles({ height: lay.topCollapsed ? "auto" : `${lay.top}px` });
    setIcon(this.collapseBtn, lay.topCollapsed ? "chevron-right" : "chevron-down");
    this.active?.scheduleFit();
  }

  toggleTop(force) {
    const lay = this.plugin.settings.layout;
    lay.topCollapsed = force === undefined ? !lay.topCollapsed : force;
    this.applyLayout();
    this.plugin.saveSettings();
  }

  /** Drag handle between the session list and the terminal. */
  initSplitter(el) {
    this.registerDomEvent(el, "mousedown", (ev) => {
      ev.preventDefault();
      const lay = this.plugin.settings.layout;
      const startY = ev.clientY;
      const start = this.topEl.offsetHeight;
      const total = this.contentEl.clientHeight;
      document.body.addClass("sa-resizing");
      const move = (e) => {
        const room = total - this.bottomEl.offsetHeight - 120; // keep room for the terminal
        const h = Math.max(90, Math.min(start + e.clientY - startY, room));
        lay.top = Math.round(h);
        this.topEl.setCssStyles({ height: `${h}px` });
        this.active?.scheduleFit();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.removeClass("sa-resizing");
        this.plugin.saveSettings();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ------------------------------------------------------------------ sessions
  addSession(s, activate = true) {
    s.mount(this.termArea);
    this.sessions.push(s);
    this.plugin.terminals.add(s);
    if (activate) this.activate(s);
    this.plugin.saveLayoutSoon();
    return s;
  }

  openSession(st) {
    return this.addSession(new TerminalSession(this.plugin, st));
  }

  activate(s) {
    if (!s) return;
    if (this.active && this.active !== s) {
      this.active.hide();
      this.active.reader?.hide();
    }
    this.active = s;
    this.plugin.setActiveTerminal(s);
    if (s.st.agent === "agy") this.plugin.refreshAgyLimits();
    else this.plugin.readClaudeLimits();
    s.show(); // starts the process if needed (also when the reading view is shown afterwards)
    if (s.viewMode === "reader") this.setViewMode(s, "reader", true);
    this.renderAll();
    this.plugin.saveLayoutSoon();
  }

  /** Switch a session between terminal and reading view. */
  setViewMode(s, mode, quiet = false) {
    s.viewMode = mode;
    s.st.viewMode = mode; // survives a restart
    if (s !== this.active) return;
    if (mode === "reader") {
      if (!s.reader) s.reader = new SessionReader(this.plugin, s, this.termArea);
      s.hide();
      s.reader.show();
      window.setTimeout(() => s.reader?.focusInput(), 30);
    } else {
      s.reader?.hide();
      s.show();
    }
    if (!quiet) {
      this.renderTabs();
      this.plugin.saveLayoutSoon();
    }
  }

  closeSession(s) {
    const i = this.sessions.indexOf(s);
    if (i < 0) return;
    s.reader?.dispose();
    s.reader = null;
    s.dispose();
    this.sessions.splice(i, 1);
    this.plugin.terminals.delete(s);
    if (this.active === s) {
      this.active = null;
      const next = this.sessions[i] || this.sessions[i - 1];
      if (next) this.activate(next);
    }
    this.renderAll();
    this.plugin.saveLayoutSoon();
  }

  // ------------------------------------------------------------------ input (into the terminal)
  /** Write text into the active session's prompt line (without submitting). */
  insertIntoTerminal(text, paste = false) {
    let s = this.active;
    if (!s) s = this.openSession({ agent: this.plugin.settings.defaultAgent, mode: "new" });
    if (s.viewMode === "reader" && s.reader?.el?.offsetParent) {
      s.reader.insert(text); // reading view: into its own input field
      return;
    }
    if (s.running && s.readyAt && Date.now() - s.readyAt > 1500) {
      s.sendText(text, paste);
      s.term?.focus();
    } else {
      // Session is starting or has ended: insert as soon as the prompt line is ready
      s.queueInsert(text, paste);
      if (s.exited) s.restart();
    }
  }

  focusInput() {
    this.active?.term?.focus();
  }

  focusSearch() {
    if (this.plugin.settings.layout.topCollapsed) this.toggleTop(false);
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  // ------------------------------------------------------------------ rendering
  renderAll() {
    if (!this.built) return;
    this.renderList();
    this.renderTabs();
    this.renderInfo();
  }

  stateLabel(s) {
    return s.running ? t("state.running") : s.exited ? t("state.ended") : t("state.notStarted");
  }

  renderTabs() {
    const el = this.tabsEl;
    el.empty();
    el.toggle(this.sessions.length > 0);
    this.emptyEl.toggle(this.sessions.length === 0);
    // Terminal ↔ reading view switch (right end of the tab bar)
    const a = this.active;
    if (a) {
      const reading = a.viewMode === "reader";
      const sw = el.createDiv({ cls: "sa-viewswitch" });
      const mk = (mode, icon, text, label) => {
        const b = sw.createEl("button", { cls: `sa-vs-btn${(mode === "reader") === reading ? " is-active" : ""}`, attr: { "aria-label": label } });
        setIcon(b.createSpan({ cls: "sa-btn-icon" }), icon);
        b.createSpan({ text });
        b.onclick = () => this.setViewMode(a, mode);
      };
      mk("terminal", "terminal-square", t("view.terminal"), t("view.terminalTip"));
      mk("reader", "book-open", t("view.reader"), t("view.readerTip"));
    }
    for (const s of this.sessions) {
      const tab = el.createDiv({ cls: `sa-tab${s === this.active ? " is-active" : ""}${s.running ? " is-running" : ""}` });
      setIcon(tab.createSpan({ cls: "sa-tab-icon" }), AGENTS[s.st.agent]?.icon || "terminal");
      tab.createSpan({ cls: "sa-tab-title", text: s.title() });
      tab.setAttr("aria-label", `${s.title()} · ${this.stateLabel(s)}`);
      const x = tab.createSpan({ cls: "sa-tab-close" });
      setIcon(x, "x");
      x.onclick = (ev) => {
        ev.stopPropagation();
        this.closeSession(s);
      };
      tab.onclick = () => this.activate(s);
      tab.onauxclick = (ev) => ev.button === 1 && this.closeSession(s);
      tab.oncontextmenu = (ev) => {
        ev.preventDefault();
        const m = new Menu();
        m.addItem((i) =>
          i
            .setTitle(t("menu.rename"))
            .setIcon("pencil")
            .onClick(() => this.plugin.renameTerminal(s)),
        );
        m.addItem((i) =>
          i
            .setTitle(t("menu.restart"))
            .setIcon("rotate-ccw")
            .onClick(() => {
              if (!s.running) return s.restart();
              s.kill();
              window.setTimeout(() => s.restart(), 800);
            }),
        );
        m.addItem((i) =>
          i
            .setTitle(t("menu.close"))
            .setIcon("x")
            .onClick(() => this.closeSession(s)),
        );
        m.showAtMouseEvent(ev);
      };
    }
  }

  renderInfo() {
    const el = this.infoEl;
    el.empty();
    const s = this.active;
    if (!s) {
      el.createSpan({ cls: "sa-info-muted", text: t("panel.empty") });
      return;
    }
    const dot = el.createSpan({ cls: `sa-dot ${s.running ? "is-running" : s.exited ? "is-exited" : ""}` });
    dot.setAttr("aria-label", this.stateLabel(s));
    setIcon(el.createSpan({ cls: "sa-info-icon" }), AGENTS[s.st.agent]?.icon || "terminal");
    const name = el.createSpan({ cls: "sa-info-name", text: s.title() });
    name.setAttr("aria-label", t("info.clickToRename"));
    name.onclick = () => this.plugin.renameTerminal(s);
    // Model and effort switches (apply to this session only)
    const chip = (icon, text, label, fn) => {
      const c = el.createEl("button", { cls: "sa-chip-btn", attr: { "aria-label": label } });
      setIcon(c.createSpan({ cls: "sa-chip-icon" }), icon);
      c.createSpan({ text });
      setIcon(c.createSpan({ cls: "sa-chip-icon" }), "chevron-down");
      c.onclick = (ev) => fn(ev);
      return c;
    };
    chip("cpu", this.plugin.modelLabel(s.model()) || t("common.default"), t("info.switchModel"), (ev) => this.plugin.modelMenu(s, ev));
    chip("gauge", s.st.effort || t("modal.effort"), t("info.switchEffort"), (ev) => this.plugin.effortMenu(s, ev));
    const bits = [];
    const e = s.entry();
    if (e?.messages) bits.push(this.countLabel(s.st.agent, e.messages));
    bits.push(s.running ? t("state.running") : s.exited ? t("info.endedHint") : t("state.starting"));
    // Usage limits and scheduled resume
    const pend = this.plugin.pending?.get(s.key);
    if (pend) {
      const w = el.createSpan({ cls: "sa-limit is-wait", text: `⏳ ${t("info.resumeAt", { time: hhmm(pend.at) })}` });
      w.setAttr("aria-label", t("info.resumeTip"));
      w.onclick = () => this.plugin.cancelPending(s);
    }
    const lim = this.plugin.limitsFor(s);
    if (lim && (lim.fiveHour || lim.week)) {
      const fmt = (b) => (b && b.used != null ? `${Math.round(b.used)} %` : "–");
      const worst = Math.max(lim.fiveHour?.used ?? 0, lim.week?.used ?? 0);
      const parts = [];
      if (lim.fiveHour) parts.push(`5h ${fmt(lim.fiveHour)}`);
      if (lim.week) parts.push(`${t("limits.week")} ${fmt(lim.week)}`);
      const prefix = s.st.agent === "agy" ? `${lim.label.replace(/ models?$/i, "")}: ` : "";
      const chipL = el.createSpan({ cls: `sa-limit${worst >= 90 ? " is-crit" : worst >= 70 ? " is-warn" : ""}`, text: prefix + parts.join(" · ") });
      const when = (b) => (b?.resetsAt ? new Date(b.resetsAt).toLocaleString(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?");
      chipL.setAttr("aria-label", t("limits.tip", { label: lim.label, five: fmt(lim.fiveHour), fiveAt: when(lim.fiveHour), week: fmt(lim.week), weekAt: when(lim.week) }));
    }
    if (s.st.agent === "claude") {
      const on = this.plugin.settings.noteContext !== false;
      const np = this.plugin.ctxPath;
      const sel = this.plugin.ctxSel;
      const nc = el.createEl("button", { cls: `sa-ctx clickable-icon${on ? " is-on" : ""}` });
      setIcon(nc.createSpan({ cls: "sa-chip-icon" }), on ? "file-text" : "file-x");
      if (on && np) nc.createSpan({ cls: "sa-ctx-name", text: np.split("/").pop().replace(/\.md$/, "") + (sel ? " ✂︎" : "") });
      nc.setAttr("aria-label", on ? t(sel ? "ctx.onSel" : "ctx.on", { path: np || t("ctx.noNote") }) : t("ctx.off"));
      nc.onclick = (ev) => {
        ev.stopPropagation();
        this.plugin.toggleNoteContext();
      };
    }
    const lockOn = !!this.plugin.settings.focusLock;
    const lock = el.createEl("button", { cls: `sa-lock clickable-icon${lockOn ? " is-on" : ""}`, attr: { "aria-label": lockOn ? t("lock.on") : t("lock.off") } });
    setIcon(lock, lockOn ? "lock" : "lock-open");
    lock.onclick = (ev) => {
      ev.stopPropagation();
      this.plugin.toggleFocusLock();
    };
    el.createSpan({ cls: "sa-info-meta", text: bits.filter(Boolean).join(" · ") });
  }

  countLabel(agent, n) {
    if (agent === "agy") return t(n === 1 ? "count.step" : "count.steps", { n });
    return t(n === 1 ? "count.prompt" : "count.prompts", { n });
  }

  setStatus(text) {
    if (!this.status) return;
    this.status.setText(text || "");
    this.status.toggleClass("is-empty", !text);
  }

  scheduleFulltext() {
    window.clearTimeout(this.ftTimer);
    if (!this.query || this.query.length < 3) {
      this.ftKeys = null;
      this.renderList();
      return;
    }
    this.ftTimer = window.setTimeout(async () => {
      const seq = ++this.ftSeq;
      this.setStatus(t("panel.fulltextRunning"));
      try {
        const keys = await this.plugin.store.fulltext(this.query);
        if (seq !== this.ftSeq) return;
        this.ftKeys = keys;
      } catch (e) {
        this.setStatus(`⚠️ ${t("panel.fulltextFailed", { msg: e.message })}`);
        return;
      }
      this.renderList();
    }, 400);
  }

  visibleEntries() {
    const store = this.plugin.store;
    const openKeys = this.plugin.openKeys();
    let list = store.sessions;
    if (this.filter === "open") list = list.filter((e) => openKeys.has(e.key));
    else if (this.filter !== "all") list = list.filter((e) => e.agent === this.filter);
    if (this.query) list = list.filter((e) => store.matches(e, this.query) || (this.fulltext && this.ftKeys && this.ftKeys.has(e.key)));
    return { list, openKeys };
  }

  renderList() {
    if (!this.listEl) return;
    for (const [id, el] of Object.entries(this.chipEls)) el.toggleClass("is-active", id === this.filter);
    const { list, openKeys } = this.visibleEntries();
    const store = this.plugin.store;
    const scroll = this.listEl.scrollTop;
    this.listEl.empty();
    if (store.loaded) {
      const ftInfo = this.fulltext && this.query && this.query.length < 3 ? ` · ${t("panel.fulltextMin")}` : "";
      this.setStatus(t("panel.count", { n: list.length, total: store.sessions.length }) + ftInfo);
    }
    let lastGroup = null;
    for (const e of list.slice(0, this.limit)) {
      const g = dayBucket(e.updated || e.created || 0);
      if (g !== lastGroup) {
        this.listEl.createDiv({ cls: "sa-group", text: g });
        lastGroup = g;
      }
      this.renderEntry(e, openKeys.has(e.key));
    }
    if (list.length > this.limit) {
      const more = this.listEl.createEl("button", { cls: "sa-more", text: t("panel.more", { n: Math.min(PAGE, list.length - this.limit), rest: list.length - this.limit }) });
      more.onclick = () => {
        this.limit += PAGE;
        this.renderList();
      };
    }
    this.listEl.scrollTop = scroll;
  }

  renderEntry(e, isOpen) {
    const store = this.plugin.store;
    const isActive = this.active && this.active.key === e.key;
    const row = this.listEl.createDiv({ cls: `sa-item sa-${e.agent}${isOpen ? " is-open" : ""}${isActive ? " is-active" : ""}` });
    const ic = row.createDiv({ cls: "sa-icon", attr: { "aria-label": AGENTS[e.agent]?.label } });
    setIcon(ic, AGENTS[e.agent]?.icon || "message-square");
    const body = row.createDiv({ cls: "sa-body" });
    const name = store.displayName(e);
    const title = body.createDiv({ cls: "sa-title", text: name });
    title.setAttr("title", [name, e.firstPrompt].filter(Boolean).join("\n\n"));
    const meta = [relTime(e.updated || e.created)];
    if (e.model) meta.push(e.model.replace(/^claude-/, ""));
    if (e.messages) meta.push(this.countLabel(e.agent, e.messages));
    const m = body.createDiv({ cls: "sa-meta" });
    if (isOpen) m.createSpan({ cls: "sa-badge is-open", text: t("badge.open") });
    m.appendText(meta.filter(Boolean).join(" · "));
    row.onclick = () => this.plugin.resume(e);
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      this.entryMenu(e).showAtMouseEvent(ev);
    };
  }

  entryMenu(e) {
    const p = this.plugin;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(t("menu.resume"))
        .setIcon("play")
        .onClick(() => p.resume(e)),
    );
    if (e.agent === "claude")
      menu.addItem((i) =>
        i
          .setTitle(t("menu.fork"))
          .setIcon("git-branch")
          .onClick(() => p.resume(e, { fork: true })),
      );
    menu.addItem((i) =>
      i
        .setTitle(t("menu.resumeWith"))
        .setIcon("cpu")
        .onClick(() => p.resumeWithOptions(e)),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("menu.rename"))
        .setIcon("pencil")
        .onClick(() => p.renameEntry(e)),
    );
    menu.addItem((i) =>
      i
        .setTitle(t("menu.copyId"))
        .setIcon("copy")
        .onClick(() => navigator.clipboard.writeText(e.id)),
    );
    return menu;
  }
}
