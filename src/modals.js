// Sidecar Agent – dialogs (new session, rename, confirm)
import { Component, MarkdownRenderer, Modal, Notice, Setting } from "obsidian";
import { AGENTS } from "./util";
import { presetLabel } from "./presets";
import { t } from "./i18n";

/** "What's new" after an update: the changelog sections since the last version the user saw. */
export class WhatsNewModal extends Modal {
  constructor(plugin, sections) {
    super(plugin.app);
    this.plugin = plugin;
    this.sections = sections;
    this.comp = new Component();
  }

  onOpen() {
    const p = this.plugin;
    this.titleEl.setText(t("whatsNew.title", { version: p.manifest.version }));
    const el = this.contentEl;
    el.addClass("sidecar-agent-whatsnew");
    this.comp.load();
    for (const s of this.sections) {
      if (this.sections.length > 1) el.createEl("h4", { text: s.version });
      const body = el.createDiv({ cls: "sa-whatsnew-body" });
      MarkdownRenderer.render(this.app, s.body, body, "", this.comp);
    }
    const bar = new Setting(el);
    bar.settingEl.addClass("sa-whatsnew-bar");
    bar.addButton((b) =>
      b.setButtonText(t("whatsNew.release")).onClick(() => window.open(`https://github.com/manuelniehues/obsidian-sidecar-agent/releases/tag/${p.manifest.version}`)),
    );
    bar.addToggle((tg) =>
      tg
        .setTooltip(t("whatsNew.toggle"))
        .setValue(p.settings.showWhatsNew !== false)
        .onChange(async (v) => {
          p.settings.showWhatsNew = v;
          await p.saveSettings();
        }),
    );
    bar.setName(t("whatsNew.toggle"));
    bar.addButton((b) => b.setButtonText(t("whatsNew.ok")).setCta().onClick(() => this.close()));
  }

  onClose() {
    this.comp.unload();
    this.contentEl.empty();
  }
}

export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

/**
 * Dialog for a new session, or for resuming with different options.
 * opts: { agent, model, effort, name, initialPrompt, title, lockAgent, hideName, hidePrompt, submitText, onSubmit(state),
 *   withNote, presetForm (edits a standard task), onSavePreset(state), allowNewestFlash }
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
      withNote: !!opts.withNote,
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
        if (v.agent === "agy" && this.opts.allowNewestFlash) d.addOption("newest-flash", t("set.agyModelFlash"));
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
      // A standard task remembers the choice: the note is the one open when it starts
      const note = this.plugin.app.workspace.getActiveFile();
      if (note || this.opts.presetForm) {
        new Setting(el)
          .setName(t("modal.withNote"))
          .setDesc(this.opts.presetForm ? t("preset.withNoteDesc") : note.path)
          .addToggle((tg) => tg.setValue(v.withNote).onChange((x) => (v.withNote = x)));
      }
    }
    const buttons = new Setting(el);
    if (this.opts.onSavePreset) {
      buttons.addButton((b) =>
        b.setButtonText(t("preset.save")).onClick(() => {
          if (!presetLabel(v)) return new Notice(t("preset.needName"));
          this.close();
          this.opts.onSavePreset({ ...v });
        }),
      );
    }
    buttons
      .addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.submitText || t("modal.start"))
          .setCta()
          .onClick(() => {
            if (this.opts.presetForm && !presetLabel(v)) return new Notice(t("preset.needName"));
            const out = { ...v };
            if (v.withNote && !this.opts.presetForm) {
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

/** Standard tasks: reorder, edit, delete, add. */
export class PresetsModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.titleEl.setText(t("preset.manageTitle"));
    this.contentEl.addClass("sidecar-agent-modal");
    this.render();
  }

  async change() {
    await this.plugin.saveSettings();
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const list = this.plugin.settings.presets;
    if (!list.length) el.createDiv({ cls: "sa-empty-hint", text: t("preset.empty") });
    list.forEach((p, i) => {
      const model = p.model === "newest-flash" ? t("set.agyModelFlash") : p.model || t("common.default");
      const move = (d) => {
        list.splice(i + d, 0, ...list.splice(i, 1));
        this.change();
      };
      new Setting(el)
        .setName(presetLabel(p))
        .setDesc(`${AGENTS[p.agent]?.label || p.agent} · ${model}`)
        .addExtraButton((b) => b.setIcon("arrow-up").setTooltip(t("preset.up")).setDisabled(i === 0).onClick(() => move(-1)))
        .addExtraButton((b) => b.setIcon("arrow-down").setTooltip(t("preset.down")).setDisabled(i === list.length - 1).onClick(() => move(1)))
        .addExtraButton((b) => b.setIcon("pencil").setTooltip(t("preset.edit")).onClick(() => this.edit(i)))
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip(t("preset.delete")).onClick(() => {
            list.splice(i, 1);
            this.change();
          }),
        );
    });
    new Setting(el).addButton((b) => b.setButtonText(t("preset.new")).setCta().onClick(() => this.edit(-1)));
  }

  /** index -1 adds a new task. */
  edit(index) {
    const list = this.plugin.settings.presets;
    new NewSessionModal(this.plugin, {
      ...(list[index] || {}),
      title: t(index < 0 ? "preset.new" : "preset.edit"),
      submitText: t("common.save"),
      presetForm: true,
      allowNewestFlash: true,
      onSubmit: (v) => {
        const p = { name: v.name, agent: v.agent, model: v.model, effort: v.effort, initialPrompt: v.initialPrompt, withNote: v.withNote };
        if (index < 0) list.push(p);
        else list[index] = p;
        this.change();
      },
    }).open();
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
