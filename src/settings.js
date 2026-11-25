// Sidecar Agent – settings
import { SECRET_ID } from "./dictation";
import { PluginSettingTab, Setting } from "obsidian";
import { t, locale, setLanguage } from "./i18n";
import { DEFAULT_FONT } from "./session";
import { AGENTS } from "./util";
import os from "os";
import { claudeVariants, splitVariant } from "./models";

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
  agyHiddenModels: "", // comma-separated terms; agy models whose id or label contains one are left out of all pickers
  notify: "unseen", // unseen | off
  claudeTaskTools: true, // CLAUDE_CODE_ENABLE_TODO_TOOLS for plugin sessions (task list → progress row)
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
  showWhatsNew: true, // changelog once after an update
  lastSeenVersion: "",
  archiveEnabled: false, // readable copy of every chat as a note in the vault
  archiveFolder: "Agent chats",
  archiveFrom: "", // YYYY-MM-DD: sessions last changed before that day get no note
  claudeVoice: true, // Claude sessions: microphone button uses Claude's own dictation
  dictationKey: "", // only used when Obsidian has no secret storage (before 1.11.4)
  dictationModel: "", // "" = newest Flash model of the key
  dictationVocabulary: "",
  taskButtonsPlace: "panel", // panel (info row, left of the lock) | statusbar
  inboxEnabled: false, // inbox button
  inboxFolder: "INBOX",
  inboxAgent: "agy",
  inboxModel: "", // "" = the agent's default model, "newest-flash" (agy), otherwise a model id
  inboxEffort: "", // Claude: set together with the model ("Opus · High")
  inboxPrompt: "", // "" = built-in message; {folder} is replaced by the folder
  inboxShowCount: true,
  inboxExtraFolders: "", // one folder outside the vault per line, counted and listed too
  inboxSkipPermissions: false,
  inboxBackground: true, // new tab in the background, the session in front stays
  inboxAuto: false, // start on its own when new files arrive
  inboxAutoHost: "", // the device the auto start was switched on on (settings may sync to other devices)
  inboxAutoMinutes: 30,
  inboxAutoHours: "", // "08:00-20:00", empty = any time
  presets: [], // standard tasks: {name, agent, model, effort, initialPrompt, withNote}
  agyIds: [], // Antigravity conversations started in this vault (agy often stores no working folder)
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
      .setName(t("set.notify"))
      .setDesc(t("set.notifyDesc"))
      .addDropdown((d) =>
        d
          .addOption("unseen", t("set.notifyUnseen"))
          .addOption("off", t("set.notifyOff"))
          .setValue(s.notify || "unseen")
          .onChange((v) => {
            s.notify = v;
            save();
          }),
      );
    new Setting(el)
      .setName(t("whatsNew.toggle"))
      .setDesc(t("set.whatsNewDesc"))
      .addToggle((tg) =>
        tg.setValue(s.showWhatsNew !== false).onChange((v) => {
          s.showWhatsNew = v;
          save();
        }),
      )
      .addExtraButton((b) => b.setIcon("sparkles").setTooltip(t("cmd.whatsNew")).onClick(() => p.showWhatsNew(true)));
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
      .setName(t("set.taskTools"))
      .setDesc(t("set.taskToolsDesc"))
      .addToggle((tg) =>
        tg.setValue(s.claudeTaskTools !== false).onChange((v) => {
          s.claudeTaskTools = v;
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
      .setName(t("set.agyHide"))
      .setDesc(t("set.agyHideDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder("flash, gpt")
          .setValue(s.agyHiddenModels || "")
          .onChange((v) => {
            s.agyHiddenModels = v;
            save();
          }),
      );
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
    // ---------------------------------------------------------------- voice input
    new Setting(el).setName(t("set.dictHeading")).setHeading();
    new Setting(el)
      .setName(t("set.claudeVoice"))
      .setDesc(t("set.claudeVoiceDesc"))
      .addToggle((tg) =>
        tg.setValue(s.claudeVoice).onChange((v) => {
          s.claudeVoice = v;
          save();
        }),
      );
    const ss = p.app.secretStorage;
    new Setting(el)
      .setName(t("set.dictKey"))
      .setDesc(t(ss ? "set.dictKeyDesc" : "set.dictKeyDescPlain"))
      .addText((tx) => {
        tx.inputEl.type = "password";
        tx.setValue(ss ? ss.getSecret(SECRET_ID) || "" : s.dictationKey)
          .onChange((v) => {
            p.dictation.ranked = null;
            if (ss) ss.setSecret(SECRET_ID, v.trim());
            else {
              s.dictationKey = v.trim();
              save();
            }
          });
      });
    new Setting(el)
      .setName(t("set.dictModel"))
      .setDesc(t("set.dictModelDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder(p.dictation.model || "gemini-…-flash")
          .setValue(s.dictationModel)
          .onChange((v) => {
            s.dictationModel = v.trim();
            p.dictation.model = "";
            p.dictation.ranked = null;
            save();
          }),
      );
    new Setting(el)
      .setName(t("set.dictVocab"))
      .setDesc(t("set.dictVocabDesc"))
      .addTextArea((tx) =>
        tx.setValue(s.dictationVocabulary).onChange((v) => {
          s.dictationVocabulary = v;
          save();
        }),
      );

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

    // ---------------------------------------------------------------- chat history
    new Setting(el).setName(t("set.archiveHeading")).setHeading();
    new Setting(el)
      .setName(t("set.archive"))
      .setDesc(t("set.archiveDesc"))
      .addToggle((tg) =>
        tg.setValue(s.archiveEnabled).onChange(async (v) => {
          s.archiveEnabled = v;
          await p.saveSettings();
          p.store.rebuild();
          if (v) p.archive.run();
        }),
      );
    new Setting(el)
      .setName(t("set.archiveFolder"))
      .setDesc(t("set.archiveFolderDesc"))
      .addText((tx) =>
        tx.setPlaceholder("Agent chats").setValue(s.archiveFolder).onChange(async (v) => {
          s.archiveFolder = v.trim();
          await p.saveSettings();
          p.store.rebuild();
        }),
      );
    new Setting(el)
      .setName(t("set.archiveFrom"))
      .setDesc(t("set.archiveFromDesc"))
      .addText((tx) =>
        tx.setPlaceholder("2026-01-31").setValue(s.archiveFrom).onChange(async (v) => {
          s.archiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "";
          await p.saveSettings();
        }),
      );

    // ---------------------------------------------------------------- inbox
    new Setting(el).setName(t("set.inboxHeading")).setHeading();
    new Setting(el)
      .setName(t("set.inbox"))
      .setDesc(t("set.inboxDesc"))
      .addToggle((tg) =>
        tg.setValue(!!s.inboxEnabled).onChange(async (v) => {
          s.inboxEnabled = v;
          await save();
          p.inbox.refresh();
        }),
      );
    new Setting(el)
      .setName(t("set.taskPlace"))
      .setDesc(t("set.taskPlaceDesc"))
      .addDropdown((d) =>
        d
          .addOption("panel", t("set.taskPlacePanel"))
          .addOption("statusbar", t("set.taskPlaceBar"))
          .setValue(s.taskButtonsPlace || "panel")
          .onChange(async (v) => {
            s.taskButtonsPlace = v;
            await save();
            p.placeTaskButtons();
          }),
      );
    new Setting(el)
      .setName(t("set.inboxFolder"))
      .setDesc(t("set.inboxFolderDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder("INBOX")
          .setValue(s.inboxFolder || "")
          .onChange(async (v) => {
            s.inboxFolder = v.trim().replace(/^\/+|\/+$/g, "") || "INBOX";
            await save();
            p.inbox.update();
          }),
      );
    new Setting(el).setName(t("set.inboxAgent")).addDropdown((d) =>
      d
        .addOption("claude", AGENTS.claude.label)
        .addOption("agy", AGENTS.agy.label)
        .setValue(s.inboxAgent || "agy")
        .onChange(async (v) => {
          s.inboxAgent = v;
          s.inboxModel = "";
          s.inboxEffort = "";
          await save();
          p.inbox.update();
          this.display();
        }),
    );
    new Setting(el)
      .setName(t("set.inboxModel"))
      .setDesc(t("set.inboxModelDesc"))
      .addDropdown(async (d) => {
        const agent = s.inboxAgent || "agy";
        d.addOption("", t("set.inboxModelDefault"));
        if (agent === "agy") d.addOption("newest-flash", t("set.agyModelFlash"));
        const models = await p.modelOptions(agent);
        let cur = s.inboxModel || "";
        if (agent === "claude") {
          for (const x of claudeVariants(models, p.claudeVersions())) d.addOption(x.value, x.label);
          if (cur && s.inboxEffort) cur = `${cur}|${s.inboxEffort}`;
        } else {
          for (const [id, label] of models) d.addOption(id, label);
        }
        if (cur && !d.selectEl.querySelector(`option[value="${CSS.escape(cur)}"]`)) d.addOption(cur, cur.replace("|", " · "));
        d.setValue(cur);
        d.onChange(async (v) => {
          const r = splitVariant(v);
          s.inboxModel = r.model || "";
          s.inboxEffort = r.effort || "";
          await save();
        });
      });
    new Setting(el)
      .setName(t("set.inboxPrompt"))
      .setDesc(t("set.inboxPromptDesc"))
      .addTextArea((ta) => {
        ta.setPlaceholder(t("inbox.defaultPrompt"))
          .setValue(s.inboxPrompt || "")
          .onChange(async (v) => {
            s.inboxPrompt = v;
            await save();
          });
        ta.inputEl.rows = 4;
        ta.inputEl.addClass("sidecar-agent-inbox-prompt");
      });
    new Setting(el)
      .setName(t("set.inboxExtra"))
      .setDesc(t("set.inboxExtraDesc"))
      .addTextArea((ta) => {
        ta.setPlaceholder("~/Downloads/Inbox")
          .setValue(s.inboxExtraFolders || "")
          .onChange(async (v) => {
            s.inboxExtraFolders = v;
            await save();
          });
        ta.inputEl.rows = 2;
        ta.inputEl.addClass("sidecar-agent-inbox-prompt");
        ta.inputEl.addEventListener("blur", () => p.inbox.tick());
      });
    new Setting(el)
      .setName(t("preset.background"))
      .setDesc(t("set.inboxBackgroundDesc"))
      .addToggle((tg) =>
        tg.setValue(s.inboxBackground !== false).onChange(async (v) => {
          s.inboxBackground = v;
          await save();
        }),
      );
    new Setting(el)
      .setName(t("modal.skipPermissions"))
      .setDesc(t("set.inboxSkipDesc"))
      .addToggle((tg) =>
        tg.setValue(!!s.inboxSkipPermissions).onChange(async (v) => {
          s.inboxSkipPermissions = v;
          await save();
        }),
      );
    const host = os.hostname();
    new Setting(el)
      .setName(t("set.inboxAuto"))
      .setDesc(
        s.inboxAuto && s.inboxAutoHost && s.inboxAutoHost !== host
          ? t("set.inboxAutoOther", { host: s.inboxAutoHost })
          : t("set.inboxAutoDesc", { host }),
      )
      .addToggle((tg) =>
        tg.setValue(!!s.inboxAuto && s.inboxAutoHost === host).onChange(async (v) => {
          await p.inbox.setAuto(v);
          this.display();
        }),
      );
    new Setting(el)
      .setName(t("set.inboxAutoMinutes"))
      .setDesc(t("set.inboxAutoMinutesDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder("30")
          .setValue(String(s.inboxAutoMinutes ?? 30))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            s.inboxAutoMinutes = Number.isFinite(n) && n >= 5 ? n : 30;
            await save();
          }),
      );
    new Setting(el)
      .setName(t("set.inboxAutoHours"))
      .setDesc(t("set.inboxAutoHoursDesc"))
      .addText((tx) =>
        tx
          .setPlaceholder("08:00-20:00")
          .setValue(s.inboxAutoHours || "")
          .onChange(async (v) => {
            s.inboxAutoHours = v.trim();
            await save();
          }),
      );
    new Setting(el).setName(t("set.inboxCount")).addToggle((tg) =>
      tg.setValue(s.inboxShowCount !== false).onChange(async (v) => {
        s.inboxShowCount = v;
        await save();
        p.inbox.update();
      }),
    );

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
