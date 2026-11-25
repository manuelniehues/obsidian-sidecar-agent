// Sidecar Agent – a task button in the status bar: starts a session with one click and shows its state
// (working, waiting for input, done, needs a look) until you open it.
import { setIcon, setTooltip } from "obsidian";
import { presetLabel } from "./presets";
import { sessionPhase } from "./task-logic";
import { t } from "./i18n";
import { AGENTS } from "./util";

// phase → icon shown instead of the button's own icon
const DONE_SHOWN_MS = 10000; // how long the check mark stays after a run
const PHASE_TEXT = { running: () => t("task.phase.running"), waiting: () => t("task.phase.waiting"), done: () => t("task.phase.done"), warning: () => t("task.phase.warning") };
const PHASE_ICONS = { running: "loader-circle", waiting: "message-circle-question", done: "circle-check", warning: "triangle-alert" };

export class TaskButton {
  /**
   * opts: { icon, cls, label() → tooltip title, details() → extra tooltip lines, start({ background }) → session,
   *   check(session) → "done" | "warning" (when the turn is over), onPhase(phase) }
   */
  constructor(plugin, opts) {
    this.plugin = plugin;
    this.o = opts;
    this.session = null;
    this.startedAt = 0;
    this.phase = "idle"; // idle | running | waiting | done | warning
    this.note = ""; // why the last run needs a look
    this.lastClick = 0;
    this.item = null; // status bar item, when the buttons sit there
    this.el = createEl("span", { cls: "sidecar-agent-task clickable-icon" });
    if (opts.cls) this.el.addClass(opts.cls);
    this.iconEl = this.el.createSpan({ cls: "sidecar-agent-task-icon" });
    this.badgeEl = this.el.createSpan({ cls: "sidecar-agent-task-badge" });
    this.el.addEventListener("click", () => this.click());
    if (opts.menu) this.el.addEventListener("contextmenu", (ev) => opts.menu(ev));
    this.off = plugin.on("terminals-changed", () => this.track());
    this.render();
    this.place();
  }

  /** In the panel's info row next to the lock (the panel collects the buttons) or in Obsidian's status bar. */
  place() {
    const bar = this.plugin.settings.taskButtonsPlace === "statusbar";
    if (bar && !this.item) {
      this.item = this.plugin.addStatusBarItem();
      this.item.addClass("sidecar-agent-task-item");
      this.item.appendChild(this.el);
    } else if (!bar && this.item) {
      this.el.detach();
      this.item.remove();
      this.item = null;
    }
    this.plugin.panel?.renderInfo();
  }

  destroy() {
    window.clearTimeout(this.doneTimer);
    this.plugin.bus.offref(this.off);
    this.el.remove();
    this.item?.remove();
    this.plugin.panel?.renderInfo();
  }

  get busy() {
    return this.phase === "running" || this.phase === "waiting";
  }

  setBadge(text) {
    this.badgeEl.setText(text || "");
  }

  /** Click: a running or finished run opens its session, otherwise a new run starts. */
  async click() {
    if (this.session && this.phase !== "idle" && this.plugin.terminals.has(this.session)) {
      const panel = await this.plugin.activatePanel(true);
      panel?.activate(this.session);
      if (!this.busy) this.setPhase("idle");
      return;
    }
    // A second click within a few seconds would start a second session for the same work
    if (Date.now() - this.lastClick < 5000) return;
    this.lastClick = Date.now();
    return this.run();
  }

  async run({ background = false } = {}) {
    this.startedAt = Date.now();
    const s = await this.o.start({ background });
    if (!s) return null;
    this.session = s;
    this.note = "";
    this.setPhase("running");
    return s;
  }

  track() {
    const s = this.session;
    if (!s) return;
    const p = sessionPhase(s, this.startedAt, this.plugin.terminals.has(s));
    if (p === "idle") {
      this.session = null;
      if (this.busy) this.setPhase("idle");
      return;
    }
    if (p === "running" || p === "waiting") return this.setPhase(p);
    // The turn is over: keep the result until the session is opened
    if (!this.busy) return;
    if (p === "failed") {
      this.note = t("task.endedEarly");
      return this.setPhase("warning");
    }
    const r = this.o.check?.(s) || { phase: "done" };
    this.note = r.note || "";
    this.setPhase(r.phase);
  }

  setPhase(p) {
    if (p === this.phase) return;
    this.phase = p;
    window.clearTimeout(this.doneTimer);
    // The check mark shows briefly, then the button's own icon is back (a warning stays until it is opened)
    if (p === "done") {
      this.doneTimer = window.setTimeout(() => {
        if (this.phase !== "done") return;
        this.session = null; // a later click starts a new run; follow-ups in that tab do not spin the button
        this.setPhase("idle");
      }, DONE_SHOWN_MS);
    }
    this.render();
    this.o.onPhase?.(p);
  }

  render() {
    setIcon(this.iconEl, PHASE_ICONS[this.phase] || this.o.icon || "play");
    this.el.dataset.phase = this.phase;
    const lines = [this.o.label()];
    if (this.phase !== "idle") lines.push(PHASE_TEXT[this.phase]() + (this.note ? ` · ${this.note}` : ""));
    lines.push(...(this.o.details?.() || []));
    setTooltip(this.el, lines.filter(Boolean).join("\n"), { placement: this.item ? "top" : "bottom" });
  }
}

/** One status bar button per standard task that has "Show in the status bar" switched on. */
export class PresetButtons {
  constructor(plugin) {
    this.plugin = plugin;
    this.buttons = new Map(); // preset object → TaskButton
  }

  refresh() {
    const want = this.plugin.settings.presets.filter((p) => p.statusBar);
    for (const [p, b] of this.buttons) {
      if (!want.includes(p)) {
        b.destroy();
        this.buttons.delete(p);
      }
    }
    for (const p of want) {
      const b = this.buttons.get(p);
      if (b) {
        b.o.icon = p.icon || AGENTS[p.agent]?.icon || "play";
        b.render();
        continue;
      }
      this.buttons.set(
        p,
        new TaskButton(this.plugin, {
          icon: p.icon || AGENTS[p.agent]?.icon || "play",
          cls: "sidecar-agent-preset",
          label: () => presetLabel(p),
          details: () => [`${AGENTS[p.agent]?.label || p.agent} · ${p.model === "newest-flash" ? t("set.agyModelFlash") : p.model || t("common.default")}`],
          start: () => this.plugin.startPreset(p),
        }),
      );
    }
  }

  destroy() {
    for (const b of this.buttons.values()) b.destroy();
    this.buttons.clear();
  }
}
