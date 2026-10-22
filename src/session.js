// Sidecar Agent – one terminal session (xterm.js + Python PTY) for Claude Code or Antigravity.
// Embedded in the sidebar panel. Several sessions run in parallel, one is visible at a time.
import { spawn } from "child_process";
import os from "os";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import PTY_HELPER from "./py/pty_helper.py";
import { AGENTS, buildEnv, mention } from "./util";
import { t } from "./i18n";

// Processes that are shutting down. Kept on window so it survives a plugin reload.
// Resuming the same session waits for them, otherwise the old process would keep e.g. Remote Control.
const EXITING = (window.__sidecarAgentExiting = window.__sidecarAgentExiting || new Map());

function cssVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

// Muted, readable palette (little yellow). Claude uses it fully when it runs with the
// "dark-ansi"/"light-ansi" based scheme (setting "Color scheme", default).
const PALETTE_DARK = {
  black: "#3a3d45",
  red: "#e27878",
  green: "#9cc49a",
  yellow: "#c9b58c",
  blue: "#86a8e7",
  magenta: "#c3a1e6",
  cyan: "#8cc6cf",
  white: "#cdd1d8",
  brightBlack: "#565c67",
  brightRed: "#ee9494",
  brightGreen: "#b3d6b1",
  brightYellow: "#d8c8a4",
  brightBlue: "#a3bdf0",
  brightMagenta: "#d4b9ef",
  brightCyan: "#a8d6dd",
  brightWhite: "#eceef1",
};
const PALETTE_LIGHT = {
  black: "#2e3138",
  red: "#b44a4a",
  green: "#3f7d3c",
  yellow: "#86703d",
  blue: "#3a62b0",
  magenta: "#8150b0",
  cyan: "#2f7d88",
  white: "#6b6f78",
  brightBlack: "#6f747d",
  brightRed: "#c25c5c",
  brightGreen: "#4e8f4a",
  brightYellow: "#94804e",
  brightBlue: "#4a72c0",
  brightMagenta: "#9164c0",
  brightCyan: "#3e8d98",
  brightWhite: "#3a3d45",
};

export function isDarkTheme() {
  return document.body.classList.contains("theme-dark");
}

/** Obsidian accent color as #rrggbb. */
export function obsidianAccent() {
  const e = document.body.createDiv();
  e.setCssStyles({ color: "var(--interactive-accent)" });
  const m = getComputedStyle(e).color.match(/\d+/g);
  e.remove();
  if (!m || m.length < 3) return "#fdb044";
  return (
    "#" +
    m
      .slice(0, 3)
      .map((x) => Number(x).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Darken (f < 1) or lighten (f > 1) a color. */
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(f > 1 ? v + (255 - v) * (f - 1) : v * f))));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function themeFromObsidian() {
  const bg = cssVar("--background-secondary", "#1e1e1e");
  // In the ANSI scheme Claude draws accents (file names, references, highlights) in blue/bright blue.
  // These two palette slots therefore carry the Obsidian accent color.
  const accent = obsidianAccent();
  const accentSlots = isDarkTheme() ? { blue: shade(accent, 0.85), brightBlue: accent } : { blue: shade(accent, 0.6), brightBlue: shade(accent, 0.7) };
  return {
    ...(isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT),
    ...accentSlots,
    background: bg,
    foreground: cssVar("--text-normal", "#dcddde"),
    cursor: cssVar("--text-normal", "#dcddde"),
    cursorAccent: bg,
    selectionBackground: cssVar("--text-selection", "rgba(120,120,255,0.35)"),
  };
}

export const DEFAULT_FONT = '"SF Mono", SFMono-Regular, Menlo, Monaco, monospace';

let SEQ = 0;

export class TerminalSession {
  constructor(plugin, st) {
    this.plugin = plugin;
    this.uid = ++SEQ;
    this.st = { ...st };
    this.viewMode = st.viewMode || "terminal";
    this.reader = null;
    this.proc = null;
    this.term = null;
    this.started = false;
    this.exited = false;
    this.lastSize = "";
    this.el = null;
    this.visible = false;
  }

  // ------------------------------------------------------------ display
  get key() {
    return this.st.sessionId ? `${this.st.agent}:${this.st.sessionId}` : null;
  }
  get running() {
    return !!this.proc;
  }
  entry() {
    return this.plugin.store.find(this.st.agent, this.st.sessionId);
  }
  title() {
    const e = this.entry();
    const name = this.st.name || (e && this.plugin.store.displayName(e));
    return name || t("session.newTitle", { agent: AGENTS[this.st.agent]?.short || "Agent" });
  }
  model() {
    if (this.st.model) return this.st.model;
    if (this.entry()?.model) return this.entry().model;
    if (this.st.agent === "agy" && !this.st.sessionId) return this.plugin.resolveAgyDefaultModel?.() || "";
    return "";
  }
  /** State for restoring (without the start message). */
  saveState() {
    const { initialPrompt, notePath, ...rest } = this.st;
    return { ...rest, mode: this.st.sessionId ? "resume" : this.st.mode };
  }
  changed() {
    this.plugin.trigger("terminals-changed", this);
  }

  /** Attach the terminal host to the container (on first display). */
  mount(parent) {
    if (this.el) return;
    this.el = parent.createDiv({ cls: "sa-term-host" });
    this.el.hide();
  }

  show() {
    this.visible = true;
    this.el.show();
    if (!this.term) this.createTerm();
    this.scheduleFit();
    if (!this.started && !this.exited) this.start();
    window.setTimeout(() => this.term?.focus(), 30);
  }

  hide() {
    this.visible = false;
    this.el?.hide();
  }

  createTerm() {
    const s = this.plugin.settings;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: s.fontFamily || DEFAULT_FONT,
      fontSize: s.fontSize || 14,
      lineHeight: s.lineHeight || 1.25,
      fontWeight: "normal",
      minimumContrastRatio: 4.5, // lift faint text against its background automatically
      fontWeightBold: "600",
      scrollback: 20000,
      macOptionIsMeta: false, // keep Option as a character key (e.g. Option+L = @ on German layouts)
      macOptionClickForcesSelection: true,
      theme: themeFromObsidian(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((ev, uri) => window.open(uri)));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.open(this.el);
    if (s.webgl !== false) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        this.term.loadAddon(gl);
      } catch (e) {
        console.warn("[sidecar-agent] WebGL not available, using the DOM renderer", e);
      }
    }
    this.term.attachCustomKeyEventHandler((ev) => this.handleKey(ev));
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.input(Buffer.from(d, "binary")));
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());
    this.resizeObs.observe(this.el);
    this.el.addEventListener("dragover", (ev) => ev.preventDefault());
    this.el.addEventListener("drop", (ev) => this.plugin.handleDrop(ev, (t) => this.sendText(t)));
  }

  applyOptions() {
    if (!this.term) return;
    const s = this.plugin.settings;
    this.term.options.fontSize = s.fontSize || 14;
    this.term.options.fontFamily = s.fontFamily || DEFAULT_FONT;
    this.term.options.lineHeight = s.lineHeight || 1.25;
    this.term.options.theme = themeFromObsidian();
    this.scheduleFit();
  }

  scheduleFit() {
    if (this.fitPending) return;
    this.fitPending = true;
    window.requestAnimationFrame(() => {
      this.fitPending = false;
      this.doFit();
    });
  }

  doFit() {
    if (!this.term || !this.visible || !this.el?.isConnected || this.el.clientWidth < 20 || this.el.clientHeight < 20) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    const size = `${this.term.rows} ${this.term.cols}`;
    if (size !== this.lastSize && this.proc?.stdio?.[3]?.writable) this.proc.stdio[3].write(`R ${size}\n`);
    this.lastSize = size;
  }

  // ------------------------------------------------------------ input
  input(data) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(data);
      return true;
    }
    if (this.exited && (data === "\r" || data === "\n")) this.restart();
    return false;
  }

  /** Send text to the program. paste=true uses bracketed paste (safe for multiple lines). */
  sendText(text, paste = false) {
    if (!this.term) return;
    if (paste) this.term.paste(text);
    else this.input(text);
  }

  /** Submit a message: insert the text, then Enter. */
  submit(text) {
    if (!this.running) {
      if (this.exited) this.restart();
      return false;
    }
    if (text) {
      if (text.includes("\n")) this.term.paste(text);
      else this.input(text);
    }
    window.setTimeout(() => this.input("\r"), text && text.includes("\n") ? 250 : 80);
    return true;
  }

  insertMention(vaultPath) {
    this.sendText(mention(vaultPath) + " ");
  }

  handleKey(ev) {
    if (ev.type !== "keydown") return true;
    const send = (s) => {
      this.input(s);
      ev.preventDefault();
      return false;
    };
    const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey;
    if (ev.key === "Enter" && ev.shiftKey && plain) return send("\x1b\r"); // new line in Claude/agy
    if (ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
      if (ev.key === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        ev.preventDefault();
        return false;
      }
      if (ev.key === "ArrowLeft") return send("\x01");
      if (ev.key === "ArrowRight") return send("\x05");
      if (ev.key === "Backspace") return send("\x15");
      if (ev.key === "k") {
        this.term.clear();
        ev.preventDefault();
        return false;
      }
      return true; // other Cmd shortcuts stay with Obsidian
    }
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
      // Send Option characters (e.g. @ [ ] { } | \ ~ on German layouts) directly, xterm's keypress path drops them
      if (ev.key.length === 1 && !ev.isComposing) return send(ev.key);
      if (ev.key === "ArrowLeft") return send("\x1bb");
      if (ev.key === "ArrowRight") return send("\x1bf");
      if (ev.key === "Backspace") return send("\x1b\x7f");
    }
    return true;
  }

  // ------------------------------------------------------------ process
  async start() {
    if (this.started || !this.term) return;
    this.started = true;
    this.exited = false;
    const waitFor = this.key && EXITING.get(this.key);
    if (waitFor) {
      this.term.write(`\x1b[2m${t("term.waitPrevious")}\x1b[0m\r\n`);
      await Promise.race([waitFor, new Promise((r) => window.setTimeout(r, 6000))]);
      if (!this.term) return;
    }
    // Never run the same Claude conversation in two processes at once
    if (this.st.agent === "claude" && this.st.sessionId && this.plugin.store.claudeSessionExists(this.st.sessionId)) {
      const other = await this.plugin.claudeRunningElsewhere(this.st.sessionId);
      if (!this.term) return;
      if (other) {
        this.term.write(`\x1b[33m${t("term.openElsewhere", { pid: other.pid || "?" })}\x1b[0m\r\n${t("term.openElsewhereHint")}\r\n`);
        this.started = false;
        this.exited = true;
        this.changed();
        return;
      }
    }
    let cmd;
    try {
      cmd = this.plugin.buildCommand(this.st);
    } catch (e) {
      this.term.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
      this.started = false;
      this.exited = true;
      this.changed();
      return;
    }
    if (cmd.stateUpdate) this.st = { ...this.st, ...cmd.stateUpdate };
    this.st.initialPrompt = undefined; // send only once
    this.st.notePath = undefined;
    this.doFit();
    const py = this.plugin.pythonPath();
    if (!py) {
      this.term.write(`\x1b[31m${t("err.noPython")}\x1b[0m\r\n`);
      this.started = false;
      this.exited = true;
      return;
    }
    const rows = this.term.rows || 24;
    const cols = this.term.cols || 80;
    const shell = this.plugin.settings.shell || process.env.SHELL || "/bin/zsh";
    const pretty = [cmd.bin.replace(os.homedir(), "~"), ...cmd.args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a.length > 50 ? a.slice(0, 47) + "…" : a) : a))].join(" ");
    this.term.write(`\x1b[2m▶ ${pretty}\x1b[0m\r\n`);
    const argv = ["-I", "-B", "-c", PTY_HELPER, String(rows), String(cols), shell, "-l", "-c", 'exec "$@"', "sidecar-agent", cmd.bin, ...cmd.args];
    const proc = spawn(py, argv, { cwd: this.plugin.vaultPath, env: buildEnv(this.plugin.agentEnv()), stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.startedAt = Date.now();
    this.readyAt = 0;
    proc.stdout.on("data", (d) => {
      this.term?.write(d);
      if (!this.readyAt) {
        this.readyAt = Date.now();
        this.flushQueueSoon();
      }
    });
    proc.stderr.on("data", (d) => this.term?.write(d.toString().replace(/\n/g, "\r\n")));
    proc.on("error", (e) => this.term?.write(`\r\n\x1b[31m${t("term.startFailed", { msg: e.message })}\x1b[0m\r\n`));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.started = false;
      this.exited = true;
      this.term?.write(`\r\n\x1b[2m[${code ? t("term.endedCode", { code }) : t("term.ended")}]\x1b[0m\r\n`);
      this.changed();
      this.plugin.store.scheduleRefresh(1500);
    });
    if (this.st.agent === "agy" && !this.st.sessionId) this.plugin.detectAgyConversation(this);
    this.changed();
    this.plugin.saveLayoutSoon();
  }

  /** Insert text once the program's prompt line is ready (shortly after the first output). */
  queueInsert(text, paste) {
    (this.queue = this.queue || []).push([text, paste]);
    if (this.readyAt && this.running) this.flushQueueSoon();
  }

  flushQueueSoon() {
    if (!this.queue?.length) return;
    window.clearTimeout(this.queueTimer);
    const wait = Math.max(0, 2500 - (Date.now() - this.readyAt));
    this.queueTimer = window.setTimeout(() => {
      if (!this.running) return;
      for (const [t, p] of this.queue.splice(0)) this.sendText(t, p);
      this.term?.focus();
    }, wait);
  }

  restart(prompt) {
    if (this.proc) return;
    this.st.mode = this.st.sessionId ? "resume" : "new";
    this.st.initialPrompt = prompt || undefined;
    this.st.notePath = undefined;
    this.exited = false;
    this.term?.write("\r\n");
    this.start();
  }

  /** Interrupt like the Esc key (Claude/agy cancel the running answer). */
  interrupt() {
    this.input("\x1b");
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    this.started = false;
    this.exited = true;
    const key = this.key;
    if (key && p.exitCode === null) {
      const done = new Promise((r) => p.once("exit", r)).then(() => EXITING.delete(key));
      EXITING.set(key, done);
    }
    try {
      p.kill("SIGTERM");
    } catch {
      // already gone
    }
    window.setTimeout(() => {
      try {
        if (p.exitCode === null) p.kill("SIGKILL"); // emergency brake; the helper normally cleans up within 6 s
      } catch {
        // already gone
      }
    }, 12000);
  }

  dispose() {
    this.kill();
    this.resizeObs?.disconnect();
    this.term?.dispose();
    this.term = null;
    this.el?.remove();
    this.el = null;
  }

  setSessionId(id) {
    if (!id || this.st.sessionId === id) return;
    this.st.sessionId = id;
    this.st.mode = "resume";
    if (this.st.name) this.plugin.setAlias(`${this.st.agent}:${id}`, this.st.name);
    this.plugin.saveLayoutSoon();
    this.changed();
  }

  rename(name) {
    this.st.name = name || undefined;
    this.plugin.saveLayoutSoon();
    this.changed();
  }
}
