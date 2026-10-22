// Sidecar Agent – settings
import { PluginSettingTab, Setting } from "obsidian";
import { t, locale, setLanguage } from "./i18n";
import { DEFAULT_FONT } from "./session";
import { AGENTS } from "./util";

// Claude Code permission mode identifiers, shown as they are
// Languages, each named in itself
const LANGUAGES = [
  ["en", "English"],
  ["de", "Deutsch"],
];
const CLAUDE_MODES = ["acceptEdits", "auto", "plan"];
const SERIF_EXAMPLE = '"Iowan Old Style", Georgia, serif';

export const DEFAULT_SETTINGS = {
  language: "", // "" = like Obsidian, "en", "de"
  defaultAgent: "claude",
  claudePath: "",
  agyPath: "",
  pythonPath: "",
  rgPath: "",
  shell: "", // empty = $SHELL, falling back to /bin/zsh
  claudeModels: "opus, sonnet, haiku",
  claudePermissionMode: "", // empty = from ~/.claude/settings.json
  claudeRemoteControl: "settings", // settings | on
  claudeTheme: "ansi", // ansi = muted plugin palette + Obsidian accent (custom:sidecar-agent), "" = Claude's own colors
  agySkipPermissions: false,
  agyRemoteControl: false,
  agyDefaultModel: "", // "" = agy's own default, "newest-flash" = newest Flash model, otherwise a model id
  autoResume: true,
  autoResumeMessage: "",
  noteContext: true,
  focusLock: false,
  fontSize: 14,
  lineHeight: 1.25,
  fontFamily: "",
  readerFont: "text", // text | interface | monospace | custom
  readerFontCustom: "",
  readerFontSize: 0, // 0 = like notes
  readerLineHeight: 0, // 0 = like notes
  webgl: true,
  openPanelOnStart: true,
  layout: { top: 280, bottom: 150, topCollapsed: false },
  aliases: {},
  agyModelsCache: null,
};

export class SidecarSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    const p = this.plugin;
    const s = p.settings;
    const save = () => p.saveSettings();
    el.empty();

    // ---------------------------------------------------------------- general
    new Setting(el)
      .setName(t("set.language"))
      .setDesc(t("set.languageDesc"))
      .addDropdown((d) =>
        d
          .addOption("", t("set.languageAuto"))
          .then((dd) => {
            for (const [code, label] of LANGUAGES) dd.addOption(code, label);
          })
          .setValue(s.language || "")
          .onChange((v) => {
            s.language = v;
            save();
            setLanguage(v);
            this.display();
          }),
      );
    new Setting(el).setName(t("set.defaultAgent")).addDropdown((d) =>
      d
        .addOption("claude", AGENTS.claude.label)
        .addOption("agy", AGENTS.agy.label)
        .setValue(s.defaultAgent)
        .onChange((v) => {
          s.defaultAgent = v;
          save();
        }),
    );
    new Setting(el).setName(t("set.openOnStart")).addToggle((tg) =>
      tg.setValue(s.openPanelOnStart).onChange((v) => {
        s.openPanelOnStart = v;
        save();
      }),
    );
    new Setting(el)
      .setName(t("set.noteContext"))
      .setDesc(t("set.noteContextDesc"))
      .addToggle((tg) => tg.setValue(s.noteContext !== false).onChange(() => p.toggleNoteContext()));
    new Setting(el)
      .setName(t("set.focusLock"))
      .setDesc(t("set.focusLockDesc"))
      .addToggle((tg) => tg.setValue(!!s.focusLock).onChange((v) => p.toggleFocusLock(v)));

    // ---------------------------------------------------------------- Claude Code
    new Setting(el).setName(AGENTS.claude.label).setHeading();
    new Setting(el)
      .setName(t("set.claudeModels"))
      .setDesc(t("set.claudeModelsDesc"))
      .addText((tx) =>
        tx.setValue(s.claudeModels).onChange((v) => {
          s.claudeModels = v;
          save();
        }),
      );
    new Setting(el)
      .setName(t("set.permissionMode"))
      .setDesc(t("set.permissionModeDesc"))
      .addDropdown((d) =>
        d
          .addOption("", t("set.fromClaude"))
          .addOption("default", t("set.permDefault"))
          .then((dd) => {
            for (const mode of CLAUDE_MODES) dd.addOption(mode, mode);
          })
          .addOption("bypassPermissions", t("set.permBypass"))
          .setValue(s.claudePermissionMode)
          .onChange((v) => {
            s.claudePermissionMode = v;
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.remoteControl"))
      .setDesc(t("set.remoteControlDesc"))
      .addDropdown((d) =>
        d
          .addOption("settings", t("set.fromClaude"))
          .addOption("on", t("set.alwaysOn"))
          .setValue(s.claudeRemoteControl === "on" ? "on" : "settings")
          .onChange((v) => {
            s.claudeRemoteControl = v;
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.colors"))
      .setDesc(t("set.colorsDesc"))
      .addDropdown((d) =>
        d
          .addOption("ansi", t("set.colorsMuted"))
          .addOption("", t("set.colorsClaude"))
          .setValue(s.claudeTheme ?? "ansi")
          .onChange((v) => {
            s.claudeTheme = v;
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.autoResume"))
      .setDesc(t("set.autoResumeDesc"))
      .addToggle((tg) =>
        tg.setValue(s.autoResume !== false).onChange((v) => {
          s.autoResume = v;
          save();
        }),
      );
    new Setting(el)
      .setName(t("set.autoResumeMessage"))
      .setDesc(t("set.autoResumeMessageDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(t("prompt.autoResume"))
          .setValue(s.autoResumeMessage || "")
          .onChange((v) => {
            s.autoResumeMessage = v.trim();
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.pathTo", { bin: "claude" }))
      .setDesc(t("set.pathAuto"))
      .addText((tx) =>
        tx
          .setPlaceholder(p.claudePath() || "~/.local/bin/claude")
          .setValue(s.claudePath)
          .onChange((v) => {
            s.claudePath = v.trim();
            save();
          }),
      );

    // ---------------------------------------------------------------- Antigravity
    new Setting(el).setName(AGENTS.agy.label).setHeading();
    new Setting(el)
      .setName(t("set.agyModel"))
      .setDesc(t("set.agyModelDesc"))
      .addDropdown(async (d) => {
        d.addOption("", t("set.agyModelOwn"));
        d.addOption("newest-flash", t("set.agyModelFlash"));
        const models = await p.modelOptions("agy");
        for (const [id, label] of models) d.addOption(id, label);
        d.setValue(s.agyDefaultModel || "");
        d.onChange((v) => {
          s.agyDefaultModel = v;
          save();
        });
      });
    new Setting(el)
      .setName(t("set.agySkip"))
      .setDesc(t("set.agySkipDesc"))
      .addToggle((tg) =>
        tg.setValue(!!s.agySkipPermissions).onChange((v) => {
          s.agySkipPermissions = v;
          save();
        }),
      );
    new Setting(el).setName(t("set.remoteControl")).addToggle((tg) =>
      tg.setValue(!!s.agyRemoteControl).onChange((v) => {
        s.agyRemoteControl = v;
        save();
      }),
    );
    new Setting(el)
      .setName(t("set.agyReload"))
      .setDesc(s.agyModelsCache ? t("set.agyReloadDesc", { n: s.agyModelsCache.models.length, at: new Date(s.agyModelsCache.at).toLocaleString(locale()) }) : t("set.agyNotLoaded"))
      .addButton((b) =>
        b.setButtonText(t("set.reload")).onClick(async () => {
          s.agyModelsCache = null;
          await p.modelOptions("agy");
          this.display();
        }),
      );
    new Setting(el)
      .setName(t("set.pathTo", { bin: "agy" }))
      .setDesc(t("set.pathAuto"))
      .addText((tx) =>
        tx
          .setPlaceholder(p.agyPath() || "~/.local/bin/agy")
          .setValue(s.agyPath)
          .onChange((v) => {
            s.agyPath = v.trim();
            save();
          }),
      );

    // ---------------------------------------------------------------- reading view
    new Setting(el).setName(t("set.readerHeading")).setHeading();
    let customEl;
    new Setting(el)
      .setName(t("set.readerFont"))
      .setDesc(t("set.readerFontDesc"))
      .addDropdown((d) =>
        d
          .addOption("text", t("set.likeNotes"))
          .addOption("interface", t("set.fontInterface"))
          .addOption("monospace", t("set.fontMono"))
          .addOption("custom", t("set.fontCustom"))
          .setValue(s.readerFont || "text")
          .onChange((v) => {
            s.readerFont = v;
            save();
            p.applyReaderStyle();
            customEl.settingEl.toggle(v === "custom");
          }),
      );
    customEl = new Setting(el)
      .setName(t("set.readerFontCustom"))
      .setDesc(t("set.readerFontCustomDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(SERIF_EXAMPLE)
          .setValue(s.readerFontCustom || "")
          .onChange((v) => {
            s.readerFontCustom = v;
            save();
            p.applyReaderStyle();
          }),
      );
    customEl.settingEl.toggle(s.readerFont === "custom");
    const sliderSetting = (name, key, min, max, step, fallback, desc) => {
      const st = new Setting(el).setName(name).setDesc(desc);
      let slider;
      st.addSlider((sl) => {
        slider = sl;
        sl.setLimits(min, max, step)
          .setValue(s[key] || fallback)
          .setDynamicTooltip()
          .onChange((v) => {
            s[key] = v;
            save();
            p.applyReaderStyle();
          });
      });
      st.addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip(t("set.likeNotes"))
          .onClick(() => {
            s[key] = 0;
            save();
            p.applyReaderStyle();
            slider.setValue(fallback);
          }),
      );
    };
    const noteSize = parseFloat(getComputedStyle(document.body).getPropertyValue("--font-text-size")) || 16;
    sliderSetting(t("set.fontSize"), "readerFontSize", 10, 26, 0.5, noteSize, t("set.fontSizeDesc"));
    sliderSetting(t("set.lineHeight"), "readerLineHeight", 1, 2, 0.05, 1.5, t("set.lineHeightDesc"));

    // ---------------------------------------------------------------- terminal
    new Setting(el).setName(t("set.terminalHeading")).setHeading();
    new Setting(el).setName(t("set.fontSize")).addSlider((sl) =>
      sl
        .setLimits(10, 22, 0.5)
        .setValue(s.fontSize)
        .setDynamicTooltip()
        .onChange((v) => {
          s.fontSize = v;
          save();
          p.applyTerminalOptions();
        }),
    );
    new Setting(el)
      .setName(t("set.termFont"))
      .setDesc(t("set.termFontDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(DEFAULT_FONT)
          .setValue(s.fontFamily)
          .onChange((v) => {
            s.fontFamily = v;
            save();
            p.applyTerminalOptions();
          }),
      );
    new Setting(el).setName(t("set.lineHeight")).addSlider((sl) =>
      sl
        .setLimits(1, 1.6, 0.05)
        .setValue(s.lineHeight || 1.25)
        .setDynamicTooltip()
        .onChange((v) => {
          s.lineHeight = v;
          save();
          p.applyTerminalOptions();
        }),
    );
    new Setting(el)
      .setName(t("set.webgl"))
      .setDesc(t("set.webglDesc"))
      .addToggle((tg) =>
        tg.setValue(s.webgl).onChange((v) => {
          s.webgl = v;
          save();
        }),
      );
    new Setting(el)
      .setName(t("set.shell"))
      .setDesc(t("set.shellDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(process.env.SHELL || "/bin/zsh")
          .setValue(s.shell)
          .onChange((v) => {
            s.shell = v.trim();
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.pathTo", { bin: "python3" }))
      .setDesc(t("set.pathAuto"))
      .addText((tx) =>
        tx
          .setPlaceholder(p.pythonPath() || "/usr/bin/python3")
          .setValue(s.pythonPath)
          .onChange((v) => {
            s.pythonPath = v.trim();
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.pathTo", { bin: "rg" }))
      .setDesc(t("set.rgDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(p.rgPath() || "/opt/homebrew/bin/rg")
          .setValue(s.rgPath)
          .onChange((v) => {
            s.rgPath = v.trim();
            save();
          }),
      );
  }
}
