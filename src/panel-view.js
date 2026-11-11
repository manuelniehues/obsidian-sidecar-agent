// Sidecar Agent – sidebar panel: sessions and search on top, terminal in the middle, info and actions below.
import { ItemView, Menu, setIcon } from "obsidian";
import { TerminalSession } from "./session";
import { SessionReader } from "./reader";
import { AGENTS, PLUGIN_NAME, dayBucket, hhmm, relTime } from "./util";
import { t, locale } from "./i18n";
import { usagePace } from "./schedule";

export const VIEW_PANEL = "sidecar-agent-panel";

const FILTERS = ["all", "open", "note", "claude", "agy"];
const PAGE = 150;

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

    // ---- sessions: list above the bars, both at the bottom of the panel (order set further down)
    this.topEl = root.createDiv({ cls: "sa-top" });
    this.barsEl = root.createDiv({ cls: "sa-bars" });
    const bar = this.barsEl.createDiv({ cls: "sa-toolbar" });
    const mk = (icon, text, label, fn, cls = "") => {
      const b = bar.createEl("button", { cls: `sa-btn ${cls}`, attr: { "aria-label": label } });
      setIcon(b.createSpan({ cls: "sa-btn-icon" }), icon);
      if (text) b.createSpan({ text });
      b.onclick = fn;
      return b;
    };
    this.collapseBtn = mk(lay.topCollapsed ? "chevron-up" : "chevron-down", t("panel.listShort"), t("panel.toggleList"), () => this.toggleTop());
    mk(AGENTS.claude.icon, "Claude", t("cmd.newClaude"), () => this.plugin.startNew({ agent: "claude" }), "mod-cta sa-claude");
    mk(AGENTS.agy.icon, "Antigravity", t("cmd.newAgy"), () => this.plugin.startNew({ agent: "agy" }), "mod-cta sa-agy");
    mk("sliders-horizontal", t("panel.tasksShort"), t("panel.newWithOptions"), (ev) => this.plugin.presetMenu(ev));
    mk("refresh-cw", t("panel.reloadShort"), t("panel.reload"), () => this.plugin.store.refresh());

    const search = this.barsEl.createDiv({ cls: "sa-search" });
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
      if (id === "note") c.setAttr("aria-label", t("filter.noteTip"));
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
    this.progressEl = root.createDiv({ cls: "sa-progress" });
    this.progressEl.hide();
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
    // Note-context chip (Claude sessions), between "Selection" and "Stop"
    this.ctxSlot = act.createDiv({ cls: "sa-ctx-slot" });
    this.micBtn = mkA("mic", "", t("panel.dictateTip"), () => this.plugin.dictation.toggle());
    this.micBtn.addClass("sa-mic");
    mkA("square", t("panel.stop"), t("cmd.interrupt"), () => this.active?.interrupt());
    // Terminal with its info rows first; the list opens right above the bars that control it
    root.append(this.split1, this.topEl, this.barsEl);

    this.applyLayout();
    this.initSplitter(this.split1);

    this.registerEvent(this.plugin.store.on("changed", () => this.renderAll()));
    this.registerEvent(this.plugin.store.on("error", (e) => this.setStatus(`⚠️ ${t("panel.indexError", { msg: e.message })}`)));
    this.registerEvent(this.plugin.on("terminals-changed", () => this.renderAll()));
    this.registerEvent(this.plugin.on("context-changed", () => this.renderInfo()));
    this.registerEvent(this.plugin.on("progress-changed", () => this.renderProgress()));
    this.registerEvent(this.plugin.on("dictation-changed", (st) => this.renderMic(st)));
    this.registerInterval(window.setInterval(() => this.tickElapsed(), 1000));
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

  renderMic(st) {
    const b = this.micBtn;
    if (!b) return;
    b.toggleClass("is-recording", st === "recording");
    b.toggleClass("is-busy", st === "transcribing");
    setIcon(b.querySelector(".sa-btn-icon"), st === "transcribing" ? "loader" : "mic");
    b.setAttr("aria-label", st === "recording" ? t("panel.dictateStop") : st === "transcribing" ? t("panel.dictateBusy") : t("panel.dictateTip"));
  }

  // ------------------------------------------------------------------ layout
  applyLayout() {
    const lay = this.plugin.settings.layout;
    this.listWrap.toggle(!lay.topCollapsed);
    this.split1.toggle(!lay.topCollapsed);
    this.topEl.setCssStyles({ height: lay.topCollapsed ? "auto" : `${lay.top}px` });
    setIcon(this.collapseBtn.querySelector(".sa-btn-icon"), lay.topCollapsed ? "chevron-up" : "chevron-down");
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
        const room = total - this.bottomEl.offsetHeight - this.barsEl.offsetHeight - 120; // keep room for the terminal
        const h = Math.max(90, Math.min(start - (e.clientY - startY), room)); // the list sits below the handle
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
    s.unseen = false;
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
    this.renderProgress();
    this.renderInfo();
  }

  /**
   * Progress row under the session tabs: steps of Claude's task list (bar, "3/7", current step) and the
   * time since the turn started. Only while the agent works, or while a task list is unfinished.
   */
  renderProgress() {
    const el = this.progressEl;
    if (!el) return;
    el.empty();
    this.elapsedEl = null;
    this.jobTimeEls = [];
    const s = this.active;
    const working = s?.running && (s.agentState === "busy" || s.agentState === "waiting");
    const p = s?.running ? this.plugin.taskProgress(s) : null;
    const jobs = s?.running && working ? this.plugin.backgroundJobs(s) : [];
    const open = p && p.done < p.total;
    if (!s || (!working && !open)) {
      el.hide();
      return;
    }
    el.show();
    el.toggleClass("sa-agy", s.st.agent === "agy");
    setIcon(el.createSpan({ cls: "sa-progress-icon" }), p ? "list-checks" : "timer");
    const tip = [];
    if (p) {
      const pct = Math.round((p.done / p.total) * 100);
      const bar = el.createSpan({ cls: "sa-progress-bar" });
      bar.createSpan({ cls: "sa-progress-fill" }).style.width = `${pct}%`;
      el.createSpan({ cls: "sa-progress-count", text: `${p.done}/${p.total}` });
      if (p.current) el.createSpan({ cls: "sa-progress-step", text: p.current });
      const mark = { completed: "✓", in_progress: "▶", pending: "○" };
      tip.push(...p.tasks.map((x) => `${mark[x.status] || "○"} ${x.subject}`));
    } else if (!jobs.length) {
      el.createSpan({ cls: "sa-progress-step is-muted", text: s.agentState === "waiting" ? t("agentState.waiting") : t("agentState.busy") });
      tip.push(t("progress.noList"));
    }
    if (jobs.length) this.renderJobs(el, jobs, tip);
    el.setAttr("aria-label", tip.join("\n"));
    if (working && s.turnStartedAt) this.elapsedEl = el.createSpan({ cls: "sa-progress-time" });
    this.tickElapsed();
  }

  /** Running background commands and subagents: up to two chips in the line, all of them in the tooltip. */
  renderJobs(el, jobs, tip) {
    const icon = { bash: "terminal", agent: "bot", monitor: "eye", other: "hourglass" };
    const kind = { bash: t("progress.kind.bash"), agent: t("progress.kind.agent"), monitor: t("progress.kind.monitor"), other: t("progress.kind.other") };
    const box = el.createSpan({ cls: "sa-progress-jobs" });
    const shown = jobs.slice(0, 2);
    for (const j of shown) {
      const chip = box.createSpan({ cls: "sa-progress-job" });
      setIcon(chip.createSpan({ cls: "sa-progress-job-icon" }), icon[j.kind] || icon.other);
      chip.createSpan({ cls: "sa-progress-job-label", text: j.label || kind[j.kind] || kind.other });
      if (j.steps) chip.createSpan({ cls: "sa-progress-job-steps", text: `· ${j.steps}` });
      this.jobTimeEls.push({ el: chip.createSpan({ cls: "sa-progress-job-time" }), at: j.startedAt });
    }
    if (jobs.length > shown.length) box.createSpan({ cls: "sa-progress-job-more", text: t("progress.more", { n: jobs.length - shown.length }) });
    if (tip.length) tip.push("");
    tip.push(t("progress.bgTitle"));
    for (const j of jobs) {
      const extra = [j.steps ? t("progress.steps", { n: j.steps }) : "", j.last ? t("progress.lastTool", { tool: j.last }) : ""].filter(Boolean).join(", ");
      tip.push(`• ${kind[j.kind] || kind.other}: ${j.label}${extra ? ` (${extra})` : ""}`);
    }
  }

  /** Every second: time since the turn started and since each background job started (only the text, no re-render). */
  tickElapsed() {
    const fmt = (ms) => {
      const sec = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const ss = String(sec % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
    };
    for (const j of this.jobTimeEls || []) if (j.at) j.el.setText(fmt(Date.now() - j.at));
    const s = this.active;
    if (!this.elapsedEl || !s?.turnStartedAt) return;
    this.elapsedEl.setText(fmt(Date.now() - s.turnStartedAt));
  }

  stateLabel(s) {
    if (s.running && (s.agentState === "busy" || s.agentState === "waiting")) return t(`agentState.${s.agentState}`);
    if (s.running && s.unseen && s.agentState === "done") return t("agentState.doneUnseen");
    return s.running ? t("state.running") : s.exited ? t("state.ended") : t("state.notStarted");
  }

  /** Is the agent producing an answer right now? Then its icon (tab and info line) pulses. */
  isBusy(s) {
    return s.running && s.agentState === "busy";
  }

  /** Small state dot: waiting for you (orange), finished while you were away (accent). Working = pulsing icon. */
  stateDot(parent, s) {
    if (!s.running) return;
    let cls = "";
    if (s.agentState === "waiting") cls = "is-waiting";
    else if (s.unseen && s.agentState !== "busy") cls = "is-unseen";
    if (!cls) return;
    parent.createSpan({ cls: `sa-state ${cls}`, attr: { "aria-label": this.stateLabel(s) } });
  }

  /** Tooltip of the schedule badge: one line per pending run. */
  scheduleTip(list) {
    const when = (ms) => {
      const d = new Date(ms);
      const today = new Date().toDateString() === d.toDateString();
      return d.toLocaleString(locale(), today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    };
    const short = (x) => (x.length > 70 ? `${x.slice(0, 69)}…` : x);
    const lines = list.map((x) =>
      x.kind === "wakeup"
        ? t("sched.wakeup", { when: when(x.at), text: short(x.text || "–") })
        : t(x.recurring ? "sched.recurring" : "sched.once", { when: when(x.at), cron: x.cron, text: short(x.text || "–") }),
    );
    return [t("sched.title"), ...lines].join("\n");
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
      const tab = el.createDiv({ cls: `sa-tab sa-${s.st.agent}${s === this.active ? " is-active" : ""}${s.running ? " is-running" : ""}` });
      const tabIcon = tab.createSpan({ cls: `sa-tab-icon${this.isBusy(s) ? " is-busy" : ""}` });
      setIcon(tabIcon, AGENTS[s.st.agent]?.icon || "terminal");
      if (this.isBusy(s)) tabIcon.setAttr("aria-label", this.stateLabel(s));
      tab.createSpan({ cls: "sa-tab-title", text: s.title() });
      this.stateDot(tab, s);
      const sched = s.st.agent === "claude" ? this.plugin.schedulesFor(s) : [];
      if (sched.length) {
        const b = tab.createSpan({ cls: "sa-sched" });
        setIcon(b, "alarm-clock");
        b.setAttr("aria-label", this.scheduleTip(sched));
      }
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
    this.renderCtxChip(s);
    if (!s) {
      el.createSpan({ cls: "sa-info-muted", text: t("panel.empty") });
      return;
    }
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
    bits.push(s.running ? this.stateLabel(s) : s.exited ? t("info.endedHint") : t("state.starting"));
    // Usage limits and scheduled resume
    const pend = this.plugin.pending?.get(s.key);
    if (pend) {
      const w = el.createSpan({ cls: "sa-limit is-wait", text: `⏳ ${t("info.resumeAt", { time: hhmm(pend.at) })}` });
      w.setAttr("aria-label", t("info.resumeTip"));
      w.onclick = () => this.plugin.cancelPending(s);
    }
    const rl = this.plugin.reloadPending;
    if (rl) {
      const w = el.createSpan({ cls: "sa-limit is-wait", text: `↻ ${t("info.reloadWaiting")}` });
      w.setAttr("aria-label", t("info.reloadTip", { list: rl.waitingFor?.join(", ") || "–" }));
      w.onclick = () => this.plugin.cancelReload();
    }
    if (s.credits) {
      const c = el.createSpan({ cls: "sa-limit is-crit sa-credits", text: `💳 ${t("credits.chip")}` });
      c.setAttr("aria-label", t("credits.tip", { time: hhmm(s.credits) }));
      c.onclick = () => {
        s.credits = 0;
        s.changed();
      };
    }
    if (s.st.agent === "claude") this.renderContext(el, s);
    else if (s.st.agent === "agy") this.renderAgyContext(el, s);
    this.renderLimits(el, s);
    const lockOn = !!this.plugin.settings.focusLock;
    const lock = el.createEl("button", { cls: `sa-lock clickable-icon${lockOn ? " is-on" : ""}`, attr: { "aria-label": lockOn ? t("lock.on") : t("lock.off") } });
    setIcon(lock, lockOn ? "lock" : "lock-open");
    lock.onclick = (ev) => {
      ev.stopPropagation();
      this.plugin.toggleFocusLock();
    };
    el.createSpan({ cls: "sa-info-meta", text: bits.filter(Boolean).join(" · ") });
  }

  /** Note-context chip in the action row (Claude only): which note goes along with each message, click toggles. */
  renderCtxChip(s) {
    const slot = this.ctxSlot;
    if (!slot) return;
    slot.empty();
    if (s?.st.agent !== "claude") return;
    const on = this.plugin.settings.noteContext !== false;
    const np = this.plugin.ctxPath;
    const sel = this.plugin.ctxSel;
    const nc = slot.createEl("button", { cls: `sa-ctx clickable-icon${on ? " is-on" : ""}` });
    setIcon(nc.createSpan({ cls: "sa-chip-icon" }), on ? "file-text" : "file-x");
    if (on && np) nc.createSpan({ cls: "sa-ctx-name", text: np.split("/").pop().replace(/\.md$/, "") + (sel ? " ✂︎" : "") });
    nc.setAttr("aria-label", on ? t(sel ? "ctx.onSel" : "ctx.on", { path: np || t("ctx.noNote") }) : t("ctx.off"));
    nc.onclick = (ev) => {
      ev.stopPropagation();
      this.plugin.toggleNoteContext();
    };
  }

  /**
   * Usage limits as small bars like the context chip: 5 h and week of the plan (Claude) or of the
   * session's model group (Antigravity), for Antigravity also the separate Gemini 4 Argon weekly quota.
   */
  renderLimits(el, s) {
    const lim = this.plugin.limitsFor(s);
    const bars = [];
    let main = lim;
    let argon = null;
    if (s.st.agent === "agy") {
      const groups = this.plugin.limits.agy?.groups || {};
      const an = Object.keys(groups).find((k) => /argon/i.test(k));
      if (an && groups[an].week) argon = { ...groups[an], label: an };
      // An Argon session: its group has only the weekly quota, 5 h and week come from the general Gemini group
      if (main && an && main.label === an) {
        const gm = Object.keys(groups).find((k) => /^gemini models$/i.test(k));
        main = gm ? { ...groups[gm], label: gm } : null;
      }
    }
    if (main?.fiveHour) bars.push({ short: t("limits.fiveShort"), win: t("limits.fiveLong"), b: main.fiveHour, group: main.label, ms: 5 * 3600000 });
    if (main?.week) bars.push({ short: t("limits.week"), win: t("limits.week"), b: main.week, group: main.label, ms: 7 * 86400000 });
    if (argon) bars.push({ short: t("limits.argonShort"), win: t("limits.week"), b: argon.week, group: argon.label, ms: 7 * 86400000 });
    const when = (b) => (b?.resetsAt ? new Date(b.resetsAt).toLocaleString(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?");
    for (const x of bars) {
      if (x.b.used == null) continue;
      const pct = Math.max(0, Math.min(100, Math.round(x.b.used)));
      const lvl = pct >= 90 ? " is-crit" : pct >= 70 ? " is-warn" : "";
      const pace = usagePace(x.b.used, x.b.resetsAt, x.ms);
      const fast = pace?.hitAt != null;
      const chip = el.createSpan({ cls: `sa-context sa-limit-bar${lvl}${/gemini/i.test(x.group) ? " is-gemini" : ""}${fast && !lvl ? " is-fast" : ""}` });
      chip.createSpan({ cls: "sa-limit-label", text: x.short });
      const bar = chip.createSpan({ cls: "sa-context-bar" });
      bar.createSpan({ cls: "sa-context-fill" }).style.width = `${pct}%`;
      // Even pace: where the use would be now if it were spread evenly over the window
      if (pace && pace.frac > 0 && pace.frac < 1) bar.createSpan({ cls: "sa-limit-tick" }).style.left = `${Math.round(pace.frac * 100)}%`;
      chip.createSpan({ cls: "sa-context-pct", text: `${pct} %` });
      let tip = t("limits.barTip", { group: x.group, win: x.win, pct, at: when(x.b) });
      if (pace?.projected != null) tip += `\n${t("limits.paceUnder", { p: pace.projected })}`;
      else if (fast) tip += `\n${t("limits.paceOver", { at: when({ resetsAt: pace.hitAt }) })}`;
      chip.setAttr("aria-label", tip);
    }
  }

  /** Context window fill level as a small bar (Claude only; Antigravity reports no context usage). */
  renderContext(el, s) {
    const c = this.plugin.readContext(s.st.sessionId);
    if (!c || c.used_percentage == null) return;
    const pct = Math.max(0, Math.min(100, Math.round(c.used_percentage)));
    const lvl = pct >= 85 ? " is-crit" : pct >= 65 ? " is-warn" : "";
    const chip = el.createSpan({ cls: `sa-context clickable${lvl}` });
    chip.onclick = (ev) => this.plugin.contextMenu(s, ev);
    setIcon(chip.createSpan({ cls: "sa-chip-icon" }), "brain");
    const bar = chip.createSpan({ cls: "sa-context-bar" });
    bar.createSpan({ cls: "sa-context-fill" }).style.width = `${pct}%`;
    chip.createSpan({ cls: "sa-context-pct", text: `${pct} %` });
    const k = (n) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    chip.setAttr("aria-label", t("context.tip", { pct, used: k(c.used_tokens ?? (c.size ? (pct / 100) * c.size : null)), size: k(c.size) }));
    if (pct >= 85 && s.running) {
      const b = el.createEl("button", { cls: "sa-compact-btn", attr: { "aria-label": t("context.compactTip") } });
      setIcon(b.createSpan({ cls: "sa-chip-icon" }), "fold-vertical");
      b.createSpan({ text: t("context.compact") });
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (ev.altKey) this.plugin.compactWithFocus(s);
        else this.plugin.compact(s);
      };
    }
  }

  /** Antigravity: absolute token count only, agy reports no context window size. */
  renderAgyContext(el, s) {
    const c = this.plugin.readAgyContext(s.st.sessionId);
    if (!c || !c.used_tokens) return;
    const n = c.used_tokens;
    const k = n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    const chip = el.createSpan({ cls: "sa-context clickable" });
    chip.onclick = (ev) => this.plugin.contextMenu(s, ev);
    setIcon(chip.createSpan({ cls: "sa-chip-icon" }), "brain");
    chip.createSpan({ cls: "sa-context-pct", text: k });
    chip.setAttr("aria-label", t("context.tipAgy", { used: n.toLocaleString(locale()) }));
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
    else if (this.filter === "note") {
      const note = this.plugin.ctxPath;
      list = note ? list.filter((e) => store.touches(e, note)) : [];
    }
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
      const noteInfo = this.filter === "note" ? ` · ${this.plugin.ctxPath ? this.plugin.ctxPath.split("/").pop().replace(/\.md$/, "") : t("ctx.noNote")}` : "";
      this.setStatus(t("panel.count", { n: list.length, total: store.sessions.length }) + noteInfo + ftInfo);
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
    if (e.messages) meta.push(this.countLabel(e.archived ? "claude" : e.agent, e.messages));
    const m = body.createDiv({ cls: "sa-meta" });
    if (isOpen) m.createSpan({ cls: "sa-badge is-open", text: t("badge.open") });
    if (e.archived) m.createSpan({ cls: "sa-badge", text: t("badge.archive") });
    m.appendText(meta.filter(Boolean).join(" · "));
    row.onclick = () => (e.archived ? this.plugin.openChatNote(e.path) : this.plugin.resume(e));
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      this.entryMenu(e).showAtMouseEvent(ev);
    };
  }

  entryMenu(e) {
    const p = this.plugin;
    const menu = new Menu();
    const note = e.archived ? e.path : p.store.noteOf.get(e.key);
    const noteItems = () => {
      if (!note) return;
      menu.addItem((i) =>
        i
          .setTitle(t("menu.openChatNote"))
          .setIcon("file-text")
          .onClick(() => p.openChatNote(note)),
      );
      for (const agent of ["claude", "agy"]) {
        menu.addItem((i) =>
          i
            .setTitle(t("menu.continueWith", { agent: AGENTS[agent].label }))
            .setIcon(AGENTS[agent].icon)
            .onClick(() => p.continueChat(note, agent)),
        );
      }
    };
    if (e.archived) {
      noteItems();
      return menu;
    }
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
    if (note) menu.addSeparator();
    noteItems();
    return menu;
  }
}
