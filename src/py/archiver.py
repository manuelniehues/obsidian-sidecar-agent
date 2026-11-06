# Sidecar Agent – chat history as Markdown notes in the vault (optional, off by default).
# Turns the session files of Claude Code and Antigravity into one readable note per chat, so Obsidian Sync
# or any other vault sync carries the history to the other devices. Only text: user messages, answers and a
# folded one-liner per tool call. Tool results and thinking stay out, which keeps notes small.
#
# Arguments as a JSON object in argv[1]:
#   {"chats":[{"agent","id","title"}], "folder":<absolute>, "cache":<file>, "claudeDir":..., "agyDb":...,
#    "from":"YYYY-MM-DD", "quietMs":30000, "now":[<chat keys written even if just changed>],
#    "labels":{"you","assistant","notice","cut","tool","tools"}}
# Prints {"written":n, "renamed":n, "skipped":n, "pending":n, "errors":[...]}.
#
# Several devices may see the same session (a synced ~/.claude). The text depends only on the session, so
# both write the same note, and source_updated keeps a device with an older copy from overwriting a newer note.
import json
import os
import re
import sys
import time
from datetime import datetime

MAX_NOTE = 4_800_000  # Obsidian Sync's standard plan skips files over 5 MB
UNSAFE = re.compile(r'[\\/:*?"<>|#^\[\]\n\r\t]+')
ID_RE = re.compile(r"^chat_id:\s*(\S+)\s*$", re.M)
STAMP_RE = re.compile(r"^source_updated:\s*(\d+)\s*$", re.M)
REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
CONTEXT_CUT = re.compile(r"\n\s*<(obsidian_context|system-reminder)\b")
COMMAND = re.compile(r"<command-name>(.*?)</command-name>(?:.*?<command-args>(.*?)</command-args>)?", re.S)
USER_REQUEST = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.S)
AGY_CONTEXT = re.compile(r"\s*<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|current_note|editor_selection)>.*?</\1>", re.S)
SKIP = ("<local-command", "<task-notification>", "<bash-stdout>", "<bash-stderr>", "[Request interrupted", "Caveat:")
DETAIL_KEYS = ("description", "toolSummary", "command", "CommandLine", "file_path", "AbsolutePath", "path", "pattern",
               "query", "url", "prompt", "skill")


def stamp(value):
    """ISO timestamp to local datetime, or None."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    except Exception:  # noqa: BLE001
        return None


def one_line(text, n=160):
    s = re.sub(r"\s+", " ", str(text)).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def safe_name(title):
    s = re.sub(r"\s{2,}", " ", UNSAFE.sub(" ", title or "")).strip(" .")
    if len(s) > 80:
        s = s[:80].rstrip(" .") + "…"
    return s or "Untitled"


def clean(text):
    """Keep a message from taking the note apart."""
    s = (text or "").replace("\r\n", "\n").strip()
    s = s.replace("![[", "[[")  # no embeds of whole notes or images
    if len(re.findall(r"^\s*```", s, re.M)) % 2:
        s += "\n```"
    return s


def tool_line(name, args):
    detail = ""
    if isinstance(args, dict):
        for k in DETAIL_KEYS:
            if args.get(k):
                detail = args[k]
                break
        if not detail:
            detail = next((v for v in args.values() if isinstance(v, str) and v.strip()), "")
    elif isinstance(args, str):
        detail = args
    d = one_line(detail).replace("`", "'")
    return "**%s**" % (name or "?") + (" `%s`" % d if d else "")


def claude_user_text(content):
    if isinstance(content, list):
        if content and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return ""
        content = "\n\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    txt = content or ""
    cut = CONTEXT_CUT.search(txt)
    if cut and cut.start() > 0:
        txt = txt[:cut.start()]
    txt = REMINDER.sub("", txt).strip()
    cmd = COMMAND.search(txt)
    if cmd:
        args = (cmd.group(2) or "").strip()
        return "`%s%s`" % (cmd.group(1).strip(), " " + args if args else "")
    return "" if txt.startswith(SKIP) else txt


def load_claude(path):
    msgs, cur = [], None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            typ = d.get("type")
            if typ not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
                continue
            if d.get("entrypoint") == "sdk-ts":  # Agent SDK runs of other tools, not a chat of the user
                continue
            msg = d.get("message") or {}
            at = stamp(d.get("timestamp"))
            if typ == "user":
                if d.get("isCompactSummary"):
                    continue
                txt = claude_user_text(msg.get("content"))
                if txt:
                    msgs.append({"role": "user", "text": clean(txt), "at": at})
                    cur = None
                continue
            model = msg.get("model") or ""
            model = "" if model == "<synthetic>" else model
            if cur is None:
                cur = {"role": "assistant", "text": "", "at": at, "tools": [], "model": model}
                msgs.append(cur)
            cur["model"] = cur["model"] or model
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and (b.get("text") or "").strip():
                    cur["text"] = (cur["text"] + "\n\n" + b["text"].strip()).strip()
                elif b.get("type") == "tool_use":
                    cur["tools"].append(tool_line(b.get("name"), b.get("input") or {}))
    for m in msgs:
        if m["role"] == "assistant":
            m["text"] = clean(m["text"])
    return msgs


def load_agy(path):
    msgs, cur, started = [], None, False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            at = stamp(d.get("created_at"))
            if d.get("type") == "USER_INPUT" and d.get("source") == "USER_EXPLICIT":
                raw = d.get("content") or ""
                m = USER_REQUEST.search(raw)
                txt = AGY_CONTEXT.sub("", m.group(1) if m else raw).strip()
                if txt:
                    started = True
                    msgs.append({"role": "user", "text": clean(txt), "at": at})
                    cur = None
            elif d.get("type") == "PLANNER_RESPONSE" and started:
                if cur is None:
                    cur = {"role": "assistant", "text": "", "at": at, "tools": [], "model": ""}
                    msgs.append(cur)
                for tc in d.get("tool_calls") or []:
                    args = {}
                    for k, v in (tc.get("args") or {}).items():
                        try:
                            args[k] = json.loads(v) if isinstance(v, str) else v
                        except Exception:  # noqa: BLE001
                            args[k] = v
                    cur["tools"].append(tool_line(tc.get("name"), args))
                if (d.get("content") or "").strip():
                    cur["text"] = clean((cur["text"] + "\n\n" + d["content"].strip()).strip())
    return msgs


def render_turns(msgs, labels, with_tools):
    out = []
    for m in msgs:
        at = m.get("at")
        if m["role"] == "user":
            head = "## %s" % labels["you"] + (" · %s" % at.strftime("%Y-%m-%d %H:%M") if at else "")
            out.append((head + "\n\n" + m["text"], True))
            continue
        tools = m.get("tools") or []
        if not tools and not m.get("text"):
            continue
        head = "## %s" % (m.get("model") or labels["assistant"]) + (" · %s" % at.strftime("%H:%M") if at else "")
        body = head
        if tools and with_tools:
            word = labels["tool"] if len(tools) == 1 else labels["tools"]
            body += "\n\n" + "\n".join(["> [!example]- %d %s" % (len(tools), word)] + ["> - " + x for x in tools])
        if m.get("text"):
            body += "\n\n" + m["text"]
        if body != head:
            out.append((body, False))
    return out


def render(chat, msgs, labels):
    """(text, meta) or None for a chat without an answer (just /clear, /mcp and the like)."""
    turns = render_turns(msgs, labels, True)
    n_user = sum(1 for _, is_user in turns if is_user)
    if not n_user or n_user == len(turns):
        return None
    times = [m["at"] for m in msgs if m.get("at")]
    created, updated = (min(times), max(times)) if times else (datetime.now(), datetime.now())
    title = (chat.get("title") or "").strip() or "Untitled"
    models = []
    for m in msgs:
        if m.get("model") and m["model"] not in models:
            models.append(m["model"])
    head = [
        "---",
        "chat_id: %s-%s" % (chat["agent"], chat["id"]),
        "title: %s" % json.dumps(title, ensure_ascii=False),
        "agent: %s" % chat["agent"],
        "models:" + ("" if models else " []"),
    ] + ["  - %s" % json.dumps(x, ensure_ascii=False) for x in models] + [
        "created: %s" % created.strftime("%Y-%m-%dT%H:%M"),
        "updated: %s" % updated.strftime("%Y-%m-%dT%H:%M"),
        "messages: %d" % n_user,
        "source_updated: %d" % int(updated.timestamp() * 1000),
        "tags:",
        "  - chat",
        "---",
        "# %s" % title,
        "",
        "> [!info] %s" % labels["notice"],
    ]
    top = "\n".join(head) + "\n\n"
    body = "\n\n".join(x for x, _ in turns) + "\n"
    if len((top + body).encode("utf-8")) > MAX_NOTE:
        # Too long for every sync plan: tool lines go first, then the oldest turns
        turns = render_turns(msgs, labels, False)
        while len(turns) > 1 and len((top + "\n\n".join(x for x, _ in turns)).encode("utf-8")) > MAX_NOTE:
            turns = turns[max(1, len(turns) // 10):]
        body = "> [!warning] %s\n\n" % labels["cut"] + "\n\n".join(x for x, _ in turns) + "\n"
    return top + body, {"created": created, "title": title, "updated": int(updated.timestamp() * 1000)}


def existing_notes(folder):
    """chat_id -> (path, source_updated) of the notes in the folder."""
    found = {}
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.endswith(".md"):
                continue
            p = os.path.join(root, name)
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    head = f.read(1500)
            except OSError:
                continue
            m = ID_RE.search(head)
            if m:
                s = STAMP_RE.search(head)
                found[m.group(1)] = (p, int(s.group(1)) if s else 0)
    return found


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = os.path.join(os.path.dirname(path), ".sidecar-agent.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def target_path(folder, meta, chat_id, taken):
    c = meta["created"]
    d = os.path.join(folder, c.strftime("%Y"), c.strftime("%Y-%m"))
    name = "%s %s" % (c.strftime("%Y-%m-%d %H%M"), safe_name(meta["title"]))
    p = os.path.join(d, name + ".md")
    if taken.get(p) not in (None, chat_id):  # same title in the same minute
        p = os.path.join(d, "%s (%s).md" % (name, chat_id[-6:]))
    return p


def source_path(a, chat):
    if chat["agent"] == "claude":
        return os.path.join(a.get("claudeDir") or "", chat["id"] + ".jsonl")
    brain = os.path.join(os.path.dirname(a.get("agyDb") or ""), "brain")
    return os.path.join(brain, chat["id"], ".system_generated", "logs", "transcript.jsonl")


def main():
    a = json.loads(sys.argv[1])
    labels = a["labels"]
    folder = a["folder"]
    quiet_ms = a.get("quietMs", 30000)
    now_keys = set(a.get("now") or [])
    since = a.get("from") or ""
    try:
        with open(a["cache"], encoding="utf-8") as f:
            cache = json.load(f)
    except Exception:  # noqa: BLE001
        cache = {}
    notes = existing_notes(folder)
    taken = {v[0]: k for k, v in notes.items()}
    stats = {"written": 0, "renamed": 0, "skipped": 0, "pending": 0, "errors": []}
    now = time.time() * 1000
    for chat in a.get("chats") or []:
        if chat["agent"] not in ("claude", "agy"):
            continue
        chat_id = "%s-%s" % (chat["agent"], chat["id"])
        src = source_path(a, chat)
        try:
            st = os.stat(src)
        except OSError:
            continue
        mtime = int(st.st_mtime * 1000)
        if since and datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d") < since:
            continue
        key = "%d:%d:%s" % (mtime, st.st_size, chat.get("title") or "")
        old = notes.get(chat_id)
        if cache.get(chat_id) == key and old:
            stats["skipped"] += 1
            continue
        if now - mtime < quiet_ms and "%s:%s" % (chat["agent"], chat["id"]) not in now_keys:
            stats["pending"] += 1  # still being written: once at the end of a turn, not with every line
            continue
        try:
            msgs = (load_claude if chat["agent"] == "claude" else load_agy)(src)
            r = render(chat, msgs, labels)
            if r is None:
                cache[chat_id] = key
                continue
            text, meta = r
            if old and old[1] > meta["updated"]:
                cache[chat_id] = key  # this device has an older copy of the session
                stats["skipped"] += 1
                continue
            new = target_path(folder, meta, chat_id, taken)
            if old and old[0] != new:
                taken.pop(old[0], None)
                taken[new] = chat_id
                write_atomic(new, text)
                os.remove(old[0])
                stats["renamed"] += 1
            elif old and read_text(old[0]) == text:
                stats["skipped"] += 1
            else:
                taken[new] = chat_id
                write_atomic(new, text)
                stats["written"] += 1
            notes[chat_id] = (new, meta["updated"])
            cache[chat_id] = key
        except Exception as e:  # noqa: BLE001
            stats["errors"].append("%s: %s" % (chat_id, e))
    try:
        os.makedirs(os.path.dirname(a["cache"]), exist_ok=True)
        tmp = a["cache"] + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, a["cache"])
    except OSError as e:
        stats["errors"].append("cache: %s" % e)
    json.dump(stats, sys.stdout, ensure_ascii=False)


main()
