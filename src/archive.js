// Sidecar Agent – chat history as notes in the vault (optional). The agents' own session files stay where they
// are; src/py/archiver.py writes a readable copy of each chat into a vault folder, so a vault sync carries the
// history to other devices. This class decides when it runs and lists the notes of chats this device lacks.
import path from "path";
import { Notice, TFolder, Vault, normalizePath } from "obsidian";
import ARCHIVER from "./py/archiver.py";
import { CACHE_DIR, vaultHash } from "./util";
import { t } from "./i18n";

const TICK_MS = 60000;
const QUIET_MS = 30000; // a session file that changed this recently is still being written
const TURN_DELAY_MS = 3000;

/** chat_id "claude-<id>" / "agy-<id>" to the session key of the list; null for other notes. */
function localKey(chatId) {
  const m = /^(claude|agy)-(.+)$/.exec(String(chatId));
  return m ? `${m[1]}:${m[2]}` : null;
}

export class ChatArchive {
  constructor(plugin) {
    this.plugin = plugin;
    this.dirty = true;
    this.running = false;
    this.again = false;
    this.nowKeys = new Set();
    this.turnTimer = null;
    this.listTimer = null;
  }

  get enabled() {
    return !!this.plugin.settings.archiveEnabled;
  }

  get folder() {
    return normalizePath(this.plugin.settings.archiveFolder || "Agent chats");
  }

  get folderAbs() {
    return path.join(this.plugin.vaultPath, this.folder);
  }

  inFolder(p) {
    return String(p || "").startsWith(this.folder + "/");
  }

  start() {
    const p = this.plugin;
    p.registerInterval(window.setInterval(() => this.dirty && this.run(), TICK_MS));
    // Notes arriving through a sync or leaving the folder change the list
    const touched = (f) => this.inFolder(f?.path) && this.listSoon();
    p.registerEvent(p.app.metadataCache.on("changed", touched));
    p.registerEvent(p.app.vault.on("delete", touched));
    p.registerEvent(p.app.vault.on("rename", touched));
    p.registerEvent(p.app.metadataCache.on("resolved", () => this.firstList()));
  }

  firstList() {
    if (this.listed) return;
    this.listed = true;
    this.listSoon();
  }

  listSoon() {
    if (this.listTimer) return;
    this.listTimer = window.setTimeout(() => {
      this.listTimer = null;
      this.plugin.store.rebuild();
    }, 1000);
  }

  stop() {
    window.clearTimeout(this.turnTimer);
    window.clearTimeout(this.listTimer);
  }

  /** The agent finished a turn: write this chat now, not after the quiet time. */
  turnEnded(s) {
    if (!this.enabled || !s.st.sessionId) return;
    this.nowKeys.add(`${s.st.agent}:${s.st.sessionId}`);
    this.dirty = true;
    window.clearTimeout(this.turnTimer);
    this.turnTimer = window.setTimeout(() => this.run(), TURN_DELAY_MS);
  }

  /** Write the notes of all changed chats. Only touches chats whose session file changed. */
  async run({ report = false } = {}) {
    if (!this.enabled) return null;
    if (this.running) {
      this.again = true;
      return null;
    }
    this.running = true;
    this.dirty = false;
    const now = [...this.nowKeys];
    this.nowKeys.clear();
    const { store, settings } = this.plugin;
    let res = null;
    try {
      res = await store.python(
        {
          chats: store.local.map((e) => ({ agent: e.agent, id: e.id, title: store.displayName(e) })),
          folder: this.folderAbs,
          cache: path.join(CACHE_DIR, `archive-${vaultHash(this.plugin.vaultPath)}.json`),
          claudeDir: store.paths.claudeDir,
          agyDb: store.paths.agyDb,
          from: settings.archiveFrom || "",
          quietMs: report ? 0 : QUIET_MS,
          now,
          labels: {
            you: t("archive.you"),
            assistant: t("archive.assistant"),
            notice: t("archive.notice"),
            cut: t("archive.cut"),
            tool: t("archive.tool"),
            tools: t("archive.tools"),
          },
        },
        ARCHIVER,
      );
      if (res.pending) this.dirty = true; // picked up by the next tick
      if (res.errors?.length) console.warn("[sidecar-agent] chat notes", res.errors);
      if (report) new Notice(t("archive.done", { n: res.written + res.renamed }));
    } catch (e) {
      console.error("[sidecar-agent] chat notes failed", e, e.stderr);
      if (report) new Notice(t("archive.failed", { msg: e.message }));
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        window.setTimeout(() => this.run(), 500);
      }
    }
    return res;
  }

  /** Chat notes in the folder, from Obsidian's metadata cache: {chatId, path, agent, title, created, updated, messages}. */
  notes() {
    if (!this.enabled) return [];
    const { vault, metadataCache } = this.plugin.app;
    const root = vault.getAbstractFileByPath(this.folder);
    if (!(root instanceof TFolder)) return [];
    const out = [];
    Vault.recurseChildren(root, (f) => {
      if (f.extension !== "md") return;
      const fm = metadataCache.getFileCache(f)?.frontmatter;
      if (!fm?.chat_id) return;
      out.push({
        chatId: String(fm.chat_id),
        path: f.path,
        agent: String(fm.agent || ""),
        title: String(fm.title || f.basename),
        created: Date.parse(fm.created) || f.stat.ctime,
        updated: Date.parse(fm.updated) || f.stat.mtime,
        messages: Number(fm.messages) || 0,
      });
    });
    return out;
  }

  /** List entries for notes without a session on this device, and a map session key -> note path. */
  entries(localKeys) {
    const list = [];
    const noteOf = new Map();
    for (const n of this.notes()) {
      const key = localKey(n.chatId);
      if (key) noteOf.set(key, n.path);
      if (key && localKeys.has(key)) continue;
      list.push({
        key: `note:${n.chatId}`,
        agent: n.agent,
        id: n.chatId,
        created: n.created,
        updated: n.updated,
        title: n.title,
        messages: n.messages,
        files: [],
        archived: true,
        path: n.path,
      });
    }
    return { list, noteOf };
  }
}
