// Sidecar Agent – dialogs (new session, rename, confirm)
import { Modal, Setting } from "obsidian";
import { AGENTS } from "./util";
import { t } from "./i18n";

export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

/**
 * Dialog for a new session, or for resuming with different options.
 * opts: { agent, model, effort, name, initialPrompt, title, lockAgent, hideName, hidePrompt, submitText, onSubmit(state) }
 */
export class NewSessionModal extends Modal {
  constructor(plugin, opts = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts;
    const s = plugin.settings;
    this.v = {
      agent: opts.agent || s.defaultAgent || "claude",
      model: opts.model ?? "",
      effort: opts.effort ?? "",
      name: opts.name || "",
      initialPrompt: opts.initialPrompt || "",
      withNote: false,
    };
  }

  onOpen() {
    this.titleEl.setText(this.opts.title || t("modal.newTitle"));
    this.contentEl.addClass("sidecar-agent-modal");
    this.render();
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    const v = this.v;
    if (!this.opts.lockAgent) {
      new Setting(el).setName(t("modal.agent")).addDropdown((d) => {
        d.addOption("claude", AGENTS.claude.label).addOption("agy", AGENTS.agy.label).setValue(v.agent);
        d.onChange((x) => {
          v.agent = x;
          v.model = "";
          this.render();
        });
      });
    }
    const models = await this.plugin.modelOptions(v.agent);
    const agyDefault = this.plugin.resolveAgyDefaultModel();
    const defLabel = v.agent === "agy" && agyDefault ? `${t("common.default")} (${agyDefault})` : t("common.default");
    new Setting(el)
      .setName(t("modal.model"))
      .setDesc(v.agent === "claude" ? t("modal.modelDescClaude") : t("modal.modelDescAgy"))
      .addDropdown((d) => {
        d.addOption("", defLabel);
        for (const [id, label] of models) d.addOption(id, label);
        if (v.model && !models.some(([id]) => id === v.model)) d.addOption(v.model, v.model);
        d.setValue(v.model).onChange((x) => (v.model = x));
      });
    new Setting(el).setName(t("modal.effort")).addDropdown((d) => {
      for (const id of EFFORTS) d.addOption(id, id || t("common.default"));
      d.setValue(v.effort).onChange((x) => (v.effort = x));
    });
    if (!this.opts.hideName) {
      new Setting(el)
        .setName(t("modal.name"))
        .setDesc(t("modal.nameDesc"))
        .addText((tx) =>
          tx
            .setValue(v.name)
            .setPlaceholder(t("modal.namePlaceholder"))
            .onChange((x) => (v.name = x.trim())),
        );
    }
    if (!this.opts.hidePrompt) {
      const s = new Setting(el).setName(t("modal.firstMessage")).setDesc(t("modal.firstMessageDesc"));
      s.settingEl.addClass("sa-prompt-setting");
      s.addTextArea((ta) => {
        ta.setValue(v.initialPrompt)
          .setPlaceholder(t("modal.firstMessagePlaceholder"))
          .onChange((x) => (v.initialPrompt = x));
        ta.inputEl.rows = 5;
      });
      const note = this.plugin.app.workspace.getActiveFile();
      if (note) {
        new Setting(el)
          .setName(t("modal.withNote"))
          .setDesc(note.path)
          .addToggle((tg) => tg.setValue(v.withNote).onChange((x) => (v.withNote = x)));
      }
    }
    new Setting(el)
      .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.submitText || t("modal.start"))
          .setCta()
          .onClick(() => {
            const out = { ...v };
            if (v.withNote) {
              const f = this.plugin.app.workspace.getActiveFile();
              if (f) out.notePath = f.path;
            }
            this.close();
            this.opts.onSubmit?.(out);
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class TextModal extends Modal {
  constructor(app, { title, value = "", placeholder = "", desc = "", onSubmit }) {
    super(app);
    this.o = { title, value, placeholder, desc, onSubmit };
  }
  onOpen() {
    this.titleEl.setText(this.o.title);
    this.contentEl.addClass("sidecar-agent-modal");
    let val = this.o.value;
    const s = new Setting(this.contentEl).setDesc(this.o.desc).addText((tx) => {
      tx.setValue(val)
        .setPlaceholder(this.o.placeholder)
        .onChange((x) => (val = x));
      tx.inputEl.addClass("sa-full-width");
      tx.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.close();
          this.o.onSubmit(val.trim());
        }
      });
      window.setTimeout(() => {
        tx.inputEl.focus();
        tx.inputEl.select();
      }, 10);
    });
    s.controlEl.addClass("sa-grow");
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("common.save"))
          .setCta()
          .onClick(() => {
            this.close();
            this.o.onSubmit(val.trim());
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(app, { title, text, ok, cancel }) {
    super(app);
    this.o = { title, text, ok: ok || "OK", cancel: cancel || t("common.cancel") };
    this.result = new Promise((r) => (this.resolve = r));
  }
  onOpen() {
    this.titleEl.setText(this.o.title);
    this.contentEl.createEl("p", { text: this.o.text });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.o.cancel).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.o.ok)
          .setWarning()
          .onClick(() => {
            this.answer = true;
            this.close();
          }),
      );
  }
  onClose() {
    this.resolve(!!this.answer);
    this.contentEl.empty();
  }
}
