// Sidecar Agent – inbox button in the status bar: one click starts a session that processes the inbox folder.
// Counts the files (vault folder plus optional folders outside the vault), can start on its own when new
// files arrive, and passes the file list to the agent.
import { Menu, Notice, TFile, TFolder, normalizePath } from "obsidian";
import os from "os";
import { t } from "./i18n";
import { AGENTS } from "./util";
import { TaskButton } from "./task-button";
import { diskFiles, fillPrompt, ignoredName, inHours, parseFolders } from "./task-logic";

/**
 * Files below a vault folder (recursive), as vault paths. The folder's own description note at its top
 * level (index.md or a folder note named like the folder) does not count.
 */
export function vaultFiles(folder, top = true, out = []) {
  for (const c of folder?.children || []) {
    if (ignoredName(c.name)) continue;
    if (c instanceof TFile) {
      if (top && c.name === `${folder.name}.md`) continue;
      out.push(c.path);
    } else if (c instanceof TFolder) vaultFiles(c, false, out);
  }
  return out;
}

export class InboxButton {
  constructor(plugin) {
    this.plugin = plugin;
    this.button = null;
    this.files = []; // vault paths + absolute paths outside the vault
    this.extraFiles = [];
    this.signature = ""; // file list when the last run ended: an auto start needs something new
    this.changedAt = 0;
    this.lastAuto = 0;
    this.timer = 0;
  }

  get s() {
    return this.plugin.settings;
  }

  start() {
    const p = this.plugin;
    const soon = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.update(), 300);
    };
    for (const ev of ["create", "delete", "rename"]) p.registerEvent(p.app.vault.on(ev, soon));
    p.register(() => window.clearTimeout(this.timer));
    // Folders outside the vault have no events: read them once a minute, check the auto start at the same time
    p.registerInterval(window.setInterval(() => this.tick(), 60000));
    this.refresh();
  }

  /** Creates or removes the status bar item to match the settings. */
  refresh() {
    if (!this.s.inboxEnabled) {
      this.button?.destroy();
      this.button = null;
      return;
    }
    if (!this.button) {
      this.button = new TaskButton(this.plugin, {
        icon: "inbox",
        cls: "sidecar-agent-inbox",
        label: () => t("inbox.tooltip", { agent: AGENTS[this.s.inboxAgent]?.label || this.s.inboxAgent }),
        details: () => this.details(),
        start: (o) => this.startSession(o),
        check: () => this.check(),
        onPhase: (ph) => {
          if (ph === "done" || ph === "warning") this.signature = this.files.join("\n");
        },
        menu: (ev) => this.menu(ev),
      });
    }
    this.tick();
  }

  folder() {
    const f = this.plugin.app.vault.getAbstractFileByPath(normalizePath(this.s.inboxFolder || "INBOX"));
    return f instanceof TFolder ? f : null;
  }

  async tick() {
    if (!this.button) return;
    await this.scan();
    this.maybeAutoStart();
  }

  /** Reads the folders outside the vault and updates the file list. */
  async scan() {
    const extra = [];
    for (const dir of parseFolders(this.s.inboxExtraFolders)) await diskFiles(dir, 0, extra);
    this.extraFiles = extra;
    this.update();
  }

  update() {
    const before = this.files.join("\n");
    this.files = [...vaultFiles(this.folder()), ...this.extraFiles];
    if (this.files.join("\n") !== before) this.changedAt = Date.now();
    if (!this.button) return;
    const n = this.files.length;
    this.button.setBadge(this.s.inboxShowCount !== false && n > 0 ? String(n) : "");
    this.button.el.toggleClass("is-empty", n === 0);
    this.button.render();
  }

  details() {
    const out = [];
    const n = this.files.length;
    if (!this.folder()) out.push(t("inbox.noFolder", { folder: this.s.inboxFolder || "INBOX" }));
    out.push(t("inbox.items", { n }));
    if (this.autoActive()) out.push(t("inbox.autoOn"));
    out.push(t("inbox.rightClick"));
    return out;
  }

  /** After a run: files still in the inbox are worth a look. */
  check() {
    this.update();
    const n = this.files.length;
    return n ? { phase: "warning", note: t("inbox.left", { n }) } : { phase: "done" };
  }

  /** Auto start runs on one device only (the one it was switched on on), so two computers never race. */
  autoActive() {
    return !!(this.s.inboxAuto && this.s.inboxAutoHost === os.hostname());
  }

  maybeAutoStart() {
    const b = this.button;
    if (!b || !this.autoActive() || b.busy || !this.files.length) return;
    const now = Date.now();
    if (now - this.changedAt < 2 * 60000) return; // let sync and downloads settle
    if (now - this.lastAuto < Math.max(5, Number(this.s.inboxAutoMinutes) || 30) * 60000) return;
    if (!inHours(this.s.inboxAutoHours)) return;
    if (this.files.join("\n") === this.signature) return; // nothing new since the last run
    this.lastAuto = now;
    b.run({ background: true });
  }

  async startSession({ background = false } = {}) {
    await this.scan();
    const s = this.s;
    const folder = normalizePath(s.inboxFolder || "INBOX");
    const template = (s.inboxPrompt || "").trim() || t("inbox.defaultPrompt");
    const session = await this.plugin.startFromForm(
      {
        agent: s.inboxAgent || "agy",
        model: s.inboxModel || "",
        effort: s.inboxEffort || "",
        initialPrompt: fillPrompt(template, { folder, folders: [folder, ...parseFolders(s.inboxExtraFolders)], files: this.files }),
        name: t("inbox.sessionName"),
        skipPermissions: !!s.inboxSkipPermissions,
      },
      { background: background || s.inboxBackground !== false },
    );
    if (!session) new Notice(t("inbox.failed"));
    else if (background || s.inboxBackground !== false) new Notice(t("inbox.startedBackground"));
    return session;
  }

  /** Command and menu: like a click, but always starts unless a run is still working. */
  async run() {
    if (!this.button) return this.startSession(); // the command works without the button too
    if (this.button.busy) return this.button.click();
    return this.button.run();
  }

  menu(ev) {
    const m = new Menu();
    m.addItem((i) => i.setTitle(t("inbox.run")).setIcon("play").onClick(() => this.run()));
    const folder = this.folder();
    if (folder) {
      m.addItem((i) =>
        i
          .setTitle(t("inbox.reveal"))
          .setIcon("folder-open")
          .onClick(() => {
            const explorer = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0];
            if (!explorer) return;
            this.plugin.app.workspace.revealLeaf(explorer);
            explorer.view.revealInFolder?.(folder);
          }),
      );
    }
    m.addItem((i) =>
      i
        .setTitle(t(this.autoActive() ? "inbox.autoDisable" : "inbox.autoEnable"))
        .setIcon(this.autoActive() ? "pause" : "timer")
        .onClick(() => this.setAuto(!this.autoActive())),
    );
    m.addItem((i) =>
      i
        .setTitle(t("inbox.settings"))
        .setIcon("settings")
        .onClick(() => {
          const setting = this.plugin.app.setting;
          setting?.open();
          setting?.openTabById(this.plugin.manifest.id);
        }),
    );
    m.showAtMouseEvent(ev);
  }

  async setAuto(on) {
    this.s.inboxAuto = on;
    this.s.inboxAutoHost = on ? os.hostname() : "";
    await this.plugin.saveSettings();
    this.button?.render();
    new Notice(t(on ? "inbox.autoOnNotice" : "inbox.autoOffNotice"));
  }
}
