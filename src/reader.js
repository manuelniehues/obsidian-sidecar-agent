// Sidecar Agent – reading view: a Claude session's history rendered like a note (Obsidian Markdown,
// clickable wikilinks), followed live from the session file ~/.claude/projects/<vault>/<id>.jsonl.
// The file is append-only (one entry per block), so reading continues from the last position.
import { Component, MarkdownRenderer, setIcon } from "obsidian";
import fs from "fs";
import path from "path";
import { t } from "./i18n";

const INITIAL_BYTES = 4 * 1024 * 1024; // on first open, read only the end of large sessions
const MAX_TURNS = 80; // older turns are hidden

/** Strip appended context blocks from user messages. */
function cleanUser(text) {
  let x = String(text || "");
  const cut = x.search(/\n\s*<(obsidian_context|system-reminder)\b/);
  if (cut > 0) x = x.slice(0, cut);
  return x.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function toolSummary(b) {
  const i = b.input || {};
  const d = i.description || i.command || i.file_path || i.pattern || i.query || i.url || i.prompt || "";
  return `${b.name}${d ? ": " + String(d).replace(/\s+/g, " ").slice(0, 140) : ""}`;
}

export class SessionReader {
  constructor(plugin, session, host) {
    this.plugin = plugin;
    this.s = session;
    this.el = host.createDiv({ cls: "sa-reader" });
    this.el.hide();
    this.scroll = this.el.createDiv({ cls: "sa-reader-scroll markdown-rendered" });
    this.scroll.setAttr("tabindex", "0");
    this.comp = new Component();
    this.comp.load();
    this.turns = []; // {key, role, text | parts[], sig, el}
    this.offset = null;
    this.rest = "";
    this.timer = null;
    // Open wikilinks in the reading view like in a note
    this.scroll.addEventListener("click", (ev) => {
      const a = ev.target.closest?.("a.internal-link");
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttr("data-href") || a.getAttr("href");
      if (href) this.plugin.app.workspace.openLinkText(href, "", ev.metaKey || ev.ctrlKey);
    });
    // Started typing? Move to the input field and keep the key
    this.scroll.addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.length !== 1) return;
      ev.preventDefault();
      this.input.value += ev.key;
      this.focusInput();
    });
    this.buildCompose();
  }

  /** Input field below the history: Enter sends, Shift+Enter adds a new line. */
  buildCompose() {
    const bar = this.el.createDiv({ cls: "sa-reader-compose" });
    this.input = bar.createEl("textarea", {
      cls: "sa-reader-input",
      attr: { rows: "1", placeholder: t("reader.placeholder", { agent: this.s.st.agent === "agy" ? "Gemini" : "Claude" }) },
    });
    const send = bar.createEl("button", { cls: "sa-reader-send clickable-icon", attr: { "aria-label": t("reader.send") } });
    setIcon(send, "send");
    const grow = () => {
      this.input.setCssStyles({ height: "auto" });
      this.input.setCssStyles({ height: Math.min(this.input.scrollHeight, 200) + "px" });
    };
    const submit = () => {
      const text = this.input.value.replace(/\s+$/, "");
      if (!text.trim()) return;
      if (this.s.submit(text) === false) return;
      this.input.value = "";
      grow();
      this.stick = true;
    };
    this.input.addEventListener("input", grow);
    this.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        submit();
      } else if (ev.key === "Escape" && !this.input.value) {
        // Escape in the empty field interrupts Claude like in the terminal
        ev.preventDefault();
        this.s.input("\x1b");
      }
    });
    this.input.addEventListener("drop", (ev) =>
      this.plugin.handleDrop(ev, (t) => {
        this.input.value += (this.input.value && !/\s$/.test(this.input.value) ? " " : "") + t;
        grow();
        this.focusInput();
      }),
    );
    send.onclick = submit;
  }

  focusInput() {
    this.input.focus();
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  /** Append text to the input field (send note/selection while in the reading view). */
  insert(text) {
    this.input.value += text;
    this.input.dispatchEvent(new Event("input"));
    this.focusInput();
  }

  get file() {
    const id = this.s.st.sessionId;
    return id ? path.join(this.plugin.store.paths.claudeDir, `${id}.jsonl`) : null;
  }

  show() {
    this.el.show();
    this.update(true);
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.update(false), 1500);
  }

  hide() {
    this.el.hide();
    window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose() {
    this.hide();
    this.comp.unload();
    this.el.remove();
  }

  /** Read new lines of the session file and redraw the affected turns. */
  update(first) {
    if (this.s.st.agent !== "claude") return this.showNote(t("reader.onlyClaude"));
    const f = this.file;
    if (!f || !fs.existsSync(f)) return this.showNote(t("reader.noHistory"));
    let size;
    try {
      size = fs.statSync(f).size;
    } catch {
      return;
    }
    if (this.offset === null) {
      this.offset = Math.max(0, size - INITIAL_BYTES);
      this.skipPartial = this.offset > 0;
      this.truncated = this.offset > 0;
    }
    if (size < this.offset) {
      // file was rewritten: start over
      this.offset = 0;
      this.turns.forEach((x) => x.el?.remove());
      this.turns = [];
    }
    if (size === this.offset && !first) return;
    const len = size - this.offset;
    let chunk = "";
    if (len > 0) {
      const fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString("utf8");
      this.offset = size;
    }
    let text = this.rest + chunk;
    const lines = text.split("\n");
    this.rest = lines.pop() || "";
    if (this.skipPartial && lines.length) {
      lines.shift();
      this.skipPartial = false;
    }
    let changed = false;
    for (const line of lines) if (line.trim() && this.ingest(line)) changed = true;
    if (changed || first) this.render();
  }

  /** Sort one line of the session file into turns. Returns true if something changed. */
  ingest(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    if (d.isSidechain || d.isMeta) return false;
    const c = d.message?.content;
    if (d.type === "user") {
      if (typeof c === "string") {
        const text = cleanUser(c);
        if (!text || text.startsWith("<")) return false;
        this.turns.push({ key: d.uuid, role: "user", text, sig: "" });
        return true;
      }
      if (Array.isArray(c)) {
        const texts = c
          .filter((b) => b.type === "text")
          .map((b) => cleanUser(b.text))
          .filter((x) => x && !x.startsWith("<"));
        if (!texts.length) return false; // tool results
        this.turns.push({ key: d.uuid, role: "user", text: texts.join("\n\n"), sig: "" });
        return true;
      }
      return false;
    }
    if (d.type === "assistant" && Array.isArray(c)) {
      let last = this.turns[this.turns.length - 1];
      if (!last || last.role !== "assistant") {
        last = { key: d.uuid, role: "assistant", parts: [], sig: "" };
        this.turns.push(last);
      }
      let added = false;
      for (const b of c) {
        if (b.type === "text" && b.text?.trim()) {
          last.parts.push({ kind: "text", text: b.text });
          added = true;
        } else if (b.type === "tool_use") {
          last.parts.push({ kind: "tool", text: toolSummary(b) });
          added = true;
        }
      }
      if (d.isApiErrorMessage) {
        last.parts.push({ kind: "error", text: c.map((b) => b.text || "").join(" ") });
        added = true;
      }
      return added;
    }
    return false;
  }

  showNote(msg) {
    if (this.noteMsg === msg) return;
    this.noteMsg = msg;
    this.scroll.empty();
    this.turns = [];
    this.offset = null;
    this.scroll.createDiv({ cls: "sa-reader-note", text: msg });
  }

  render() {
    if (this.noteMsg) {
      this.scroll.empty();
      this.noteMsg = null;
    }
    const sc = this.scroll;
    const atBottom = this.stick || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    this.stick = false;
    // Keep only the most recent turns
    if (this.turns.length > MAX_TURNS) {
      for (const old of this.turns.splice(0, this.turns.length - MAX_TURNS)) old.el?.remove();
      this.truncated = true;
    }
    if (this.truncated && !sc.querySelector(".sa-reader-more")) {
      sc.prepend(createDiv({ cls: "sa-reader-more", text: t("reader.truncated") }));
    }
    for (const turn of this.turns) {
      const sig = turn.role === "user" ? turn.text.length + "" : turn.parts.map((p) => p.kind + p.text.length).join("|");
      if (turn.el && turn.sig === sig) continue;
      turn.sig = sig;
      const box = createDiv({ cls: `sa-turn sa-turn-${turn.role}` });
      if (turn.el) turn.el.replaceWith(box);
      else sc.appendChild(box);
      turn.el = box;
      const head = box.createDiv({ cls: "sa-turn-head" });
      setIcon(head.createSpan({ cls: "sa-turn-icon" }), turn.role === "user" ? "user" : "sparkles");
      head.createSpan({ text: turn.role === "user" ? t("reader.you") : "Claude" });
      const body = box.createDiv({ cls: "sa-turn-body" });
      if (turn.role === "user") {
        MarkdownRenderer.render(this.plugin.app, turn.text, body, "", this.comp);
        continue;
      }
      // Collapse tool calls between text blocks into one folded line
      let tools = [];
      const flushTools = () => {
        if (!tools.length) return;
        const det = body.createEl("details", { cls: "sa-tools" });
        det.createEl("summary", { text: t(tools.length === 1 ? "reader.toolCall" : "reader.toolCalls", { n: tools.length }) });
        const ul = det.createEl("ul");
        for (const x of tools) ul.createEl("li", { text: x });
        tools = [];
      };
      for (const p of turn.parts) {
        if (p.kind === "tool") {
          tools.push(p.text);
          continue;
        }
        flushTools();
        if (p.kind === "error") {
          body.createDiv({ cls: "sa-turn-error", text: p.text });
          continue;
        }
        const md = body.createDiv();
        MarkdownRenderer.render(this.plugin.app, p.text, md, "", this.comp);
      }
      flushTools();
    }
    if (atBottom) sc.scrollTop = sc.scrollHeight;
  }
}
