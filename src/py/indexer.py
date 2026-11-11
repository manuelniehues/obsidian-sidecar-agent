# Sidecar Agent – session index
# Reads Claude Code sessions (~/.claude/projects/<vault>/*.jsonl) and Antigravity CLI conversations
# (~/.gemini/antigravity-cli/conversation_summaries.db, read-only). Prints JSON to stdout.
#
# Modes (arguments as a JSON object in argv[1]):
#   {"mode":"index", "cache":..., "vault":..., "claudeDir":..., "agyDb":...}
#   {"mode":"search", "query":..., "rg":..., "claudeDir":..., "agyDb":..., "vault":...}
# Never writes into the vault. The cache lives in ~/Library/Caches/sidecar-agent/.
import json
import os
import re
import sqlite3
import subprocess
import sys
import unicodedata
from datetime import datetime

CACHE_VERSION = 6
MAX_FILES = 300  # vault files remembered per session (for the "this note" filter)


def ms(dt_str):
    if not dt_str:
        return 0
    try:
        s = dt_str.replace("Z", "+00:00")
        if " " in s and "T" not in s:
            s = s.replace(" ", "T", 1)
        # Python < 3.11 only accepts 6 fractional digits
        s = re.sub(r"(\.\d{6})\d+", r"\1", s)
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:  # noqa: BLE001
        return 0


def to_int(v):
    try:
        return int(v)
    except Exception:  # noqa: BLE001
        return 0


def clean_prompt(text):
    if not isinstance(text, str):
        return ""
    t = text.strip()
    # Drop context blocks appended after the actual question
    cut = re.search(r"\n\s*<(obsidian_context|system-reminder)\b", t)
    if cut:
        t = t[:cut.start()]
    t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S).strip()
    return re.sub(r"\s+", " ", t)[:300]


def message_text(msg):
    c = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "tool_result":
                    return ""
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
        return "\n".join(parts)
    return ""


def vault_rel(p, vault):
    """Vault-relative path (NFC) of a file the agent touched, or None if it is outside the vault."""
    if not isinstance(p, str):
        return None
    p = p.strip().strip("\"'").strip()
    if not p or "\n" in p or len(p) > 500 or any(c in p for c in "$*?{}`<>|"):
        return None
    if p.startswith("~/"):
        p = os.path.expanduser(p)
    if p.startswith("/"):
        root = vault.rstrip("/") + "/"
        if not p.startswith(root):
            return None
        p = p[len(root):]
    elif p.startswith("./"):
        p = p[2:]
    p = unicodedata.normalize("NFC", p)
    if not p or p.startswith(".") or p.startswith("../"):
        return None
    return p


# Paths of notes in shell commands: quoted strings or plain words ending in a note extension
NOTE_EXT = r"(?:md|canvas|base|pdf)"
CMD_PATH_RE = re.compile(
    r'"([^"\n]+?\.' + NOTE_EXT + r')"|\'([^\'\n]+?\.' + NOTE_EXT + r')\'|(?<![\w/"\'.])((?:[\w.\-~]+/)*[\w.\-]+\.' + NOTE_EXT + r')\b'
)
MENTION_RE = re.compile(r'@"([^"\n]+)"|(?<![\w@])@((?:[\w.\-]+/)*[\w.\-]+\.\w+)')
PATH_KEYS = ("file_path", "notebook_path", "path", "filePath")


def add_path(out, p, vault):
    r = vault_rel(p, vault)
    if r and r not in out and len(out) < MAX_FILES:
        out.append(r)


def tool_files(name, inp, vault, out):
    """Vault files a Claude tool call reads or writes."""
    if not isinstance(inp, dict):
        return
    for k in PATH_KEYS:
        v = inp.get(k)
        if isinstance(v, str) and (name != "Grep" and name != "Glob" or "." in os.path.basename(v)):
            add_path(out, v, vault)
    cmd = inp.get("command")
    if isinstance(cmd, str):
        for m in CMD_PATH_RE.finditer(cmd):
            add_path(out, m.group(1) or m.group(2) or m.group(3), vault)


def mention_files(text, vault, out):
    for m in MENTION_RE.finditer(text or ""):
        add_path(out, m.group(1) or m.group(2), vault)


COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>(?:.*?<command-args>(.*?)</command-args>)?", re.S)


LINE_RE = {
    "title": re.compile(rb'^[^\n]*"(?:custom-title|ai-title)"[^\n]*$', re.M),
    "last": re.compile(rb'^[^\n]*"type":"last-prompt"[^\n]*$', re.M),
    "user": re.compile(rb'^[^\n]*"type":"user"[^\n]*$', re.M),
    "ts": re.compile(rb'"timestamp":"([^"]+)"'),
    "cwd": re.compile(rb'"cwd":"((?:[^"\\]|\\.)*)"'),
    "model": re.compile(rb'"model":"([A-Za-z0-9.\-\[\]_:]+)"'),
    "tool": re.compile(rb'^[^\n]*"tool_use"[^\n]*$', re.M),
}


def parse_claude(path, vault=""):
    with open(path, "rb") as f:
        data = f.read()
    sid = os.path.basename(path)[:-6]
    custom = ai = None
    for m in LINE_RE["title"].finditer(data):
        try:
            d = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            continue
        if d.get("type") == "custom-title" and d.get("customTitle"):
            custom = d["customTitle"]
        elif d.get("type") == "ai-title" and d.get("aiTitle"):
            ai = d["aiTitle"]
    last_prompt = ""
    lm = None
    for lm in LINE_RE["last"].finditer(data):
        pass
    if lm:
        try:
            last_prompt = clean_prompt(json.loads(lm.group(0)).get("lastPrompt", ""))
        except Exception:  # noqa: BLE001
            pass
    first = ""
    users = 0
    files = []
    for m in LINE_RE["user"].finditer(data):
        try:
            d = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            continue
        if d.get("type") != "user" or d.get("isMeta") or d.get("isSidechain"):
            continue
        txt = message_text(d.get("message") or {})
        if not txt:
            continue
        s = txt.strip()
        cmd = COMMAND_RE.search(s) if s.startswith("<command-") else None
        if cmd:
            # A slash command like /neues-gutachten is a real prompt: count it as "/name args"
            args = (cmd.group(2) or "").strip()
            s = cmd.group(1).strip() + (" " + args if args else "")
        elif s.startswith("<") or s.startswith("Caveat:") or s.startswith("[Request interrupted"):
            continue
        users += 1
        if not first:
            first = clean_prompt(s)
        if vault:
            cut = re.search(r"\n\s*<(obsidian_context|system-reminder)\b", s)
            mention_files(s[:cut.start()] if cut else s, vault, files)
    if vault:
        for m in LINE_RE["tool"].finditer(data):
            try:
                d = json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                continue
            if d.get("type") != "assistant" or d.get("isSidechain"):
                continue
            for b in (d.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    tool_files(b.get("name"), b.get("input"), vault, files)
    model = ""
    for m in reversed(list(LINE_RE["model"].finditer(data[-3_000_000:]))):
        v = m.group(1).decode("utf-8", "ignore")
        if v and not v.startswith("<") and v != "synthetic":
            model = v
            break
    ts = LINE_RE["ts"].search(data)
    cwd = LINE_RE["cwd"].search(data)
    st = os.stat(path)
    return {
        "id": sid,
        "customTitle": custom or "",
        "aiTitle": ai or "",
        "firstPrompt": first,
        "lastPrompt": last_prompt,
        "userMessages": users,
        "model": model,
        "created": ms(ts.group(1).decode()) if ts else int(st.st_birthtime * 1000) if hasattr(st, "st_birthtime") else 0,
        "updated": int(st.st_mtime * 1000),
        "cwd": json.loads(b'"' + cwd.group(1) + b'"') if cwd else "",
        "size": st.st_size,
        "files": files,
    }


def scan_dir(directory, suffix, parser, cache_part):
    out = {}
    if not directory or not os.path.isdir(directory):
        return out
    for name in os.listdir(directory):
        if not name.endswith(suffix):
            continue
        path = os.path.join(directory, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = "%d:%d" % (int(st.st_mtime * 1000), st.st_size)
        cached = cache_part.get(name)
        if cached and cached.get("k") == key:
            out[name] = cached
            continue
        try:
            out[name] = {"k": key, "e": parser(path)}
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("%s: %s\n" % (name, e))
    return out


def agy_list(db, vault, known=()):
    if not db or not os.path.exists(db):
        return []
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=2)
    try:
        rows = con.execute(
            "select conversation_id, title, preview, step_count, last_modified_time, workspace_uris, "
            "last_user_input_time, agent_name, parent_conversation_id from conversation_summaries"
        ).fetchall()
    finally:
        con.close()
    vault_uri = "file://" + vault.rstrip("/")
    out = []
    for cid, title, preview, steps, mod, ws, last_input, agent, parent in rows:
        try:
            uris = json.loads(ws) if ws else []
        except Exception:  # noqa: BLE001
            uris = []
        if not any(u.rstrip("/") == vault_uri for u in uris) and cid not in known:
            continue
        if parent:
            continue
        out.append({
            "id": cid,
            "title": title or "",
            "preview": re.sub(r"\s+", " ", preview or "")[:300],
            "steps": steps or 0,
            "updated": ms(mod),
            "lastInput": ms(last_input),
            "agent": agent or "",
        })
    return out


# agy tool calls carry paths as JSON strings with literal quotes ("Path":"\"/abs/path\""), any key name
def agy_arg(v):
    """agy stores tool arguments JSON-encoded a second time ("Path":"\\"/abs/path\\"")."""
    if isinstance(v, str) and len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return v[1:-1]
    return v


AGY_TOOL_RE = re.compile(rb'^[^\n]*"tool_calls"[^\n]*$', re.M)


def agy_transcript_files(brain, cid, vault, cached):
    """Vault files touched in an Antigravity conversation (from its transcript); cached by mtime/size."""
    f = os.path.join(brain, cid, ".system_generated", "logs", "transcript.jsonl")
    try:
        st = os.stat(f)
    except OSError:
        return [], None
    key = "%d:%d" % (int(st.st_mtime * 1000), st.st_size)
    if cached and cached.get("k") == key:
        return cached.get("f", []), cached
    out = []
    try:
        with open(f, "rb") as fh:
            data = fh.read()
        for m in AGY_TOOL_RE.finditer(data):
            try:
                d = json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                continue
            for call in d.get("tool_calls") or []:
                for k, v in ((call or {}).get("args") or {}).items():
                    v = agy_arg(v)
                    if not isinstance(v, str):
                        continue
                    if k == "CommandLine":
                        for cm in CMD_PATH_RE.finditer(v):
                            add_path(out, cm.group(1) or cm.group(2) or cm.group(3), vault)
                    elif "path" in k.lower() or "file" in k.lower():
                        add_path(out, v, vault)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("agy transcript %s: %s\n" % (cid, e))
    rec = {"k": key, "f": out}
    return out, rec


def cmd_index(a):
    cache_file = a["cache"]
    try:
        with open(cache_file, "r", encoding="utf-8") as f:
            cache = json.load(f)
        if cache.get("v") != CACHE_VERSION:
            cache = {}
    except Exception:  # noqa: BLE001
        cache = {}
    vault = a.get("vault") or ""
    claude = scan_dir(a.get("claudeDir"), ".jsonl", lambda p: parse_claude(p, vault), cache.get("claude", {}))
    try:
        agy = agy_list(a.get("agyDb"), vault, set(a.get("agyIds") or []))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("agy: %s\n" % e)
        agy = []
    agy_files = {}
    old_files = cache.get("agyFiles", {})
    brain = os.path.join(os.path.dirname(a.get("agyDb") or ""), "brain")
    for c in agy:
        c["files"], agy_files[c["id"]] = agy_transcript_files(brain, c["id"], vault, old_files.get(c["id"]))
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        tmp = cache_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": CACHE_VERSION, "claude": claude, "agyFiles": agy_files}, f, ensure_ascii=False)
        os.replace(tmp, cache_file)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("cache not writable: %s\n" % e)
    json.dump({
        "claude": [v["e"] for v in claude.values()],
        "agy": agy,
    }, sys.stdout, ensure_ascii=False)


def rg_files(rg, query, directory, glob):
    if not directory or not os.path.isdir(directory):
        return []
    if rg and os.path.exists(rg):
        r = subprocess.run([rg, "-l", "-i", "-F", "--max-depth", "1", "--glob", glob, "--", query, directory],
                           capture_output=True, text=True)
        return [os.path.basename(x) for x in r.stdout.splitlines() if x]
    # Without ripgrep: case-insensitive also for umlauts (bytes.lower() only knows ASCII)
    hits = []
    q = query.casefold()
    suffix = glob.lstrip("*")
    for name in os.listdir(directory):
        if name.endswith(suffix):
            with open(os.path.join(directory, name), "rb") as f:
                if q in f.read().decode("utf-8", "replace").casefold():
                    hits.append(name)
    return hits


def search_notes(directory, query):
    """chat_id of the chat notes in the folder that contain the query."""
    q = query.casefold()
    hits = []
    for root, dirs, files in os.walk(directory or ""):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.endswith(".md"):
                continue
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                text = f.read()
            m = re.search(r"^chat_id:\s*(\S+)\s*$", text[:1500], re.M)
            if m and q in text.casefold():
                hits.append(m.group(1))
    return hits


def cmd_search(a):
    q = a["query"]
    claude = [n[:-6] for n in rg_files(a.get("rg"), q, a.get("claudeDir"), "*.jsonl")]
    agy = []
    db = a.get("agyDb")
    if db and os.path.exists(db):
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=2)
        try:
            rows = []
            try:
                rows = con.execute("select distinct conversation_id from conversations_fts where conversations_fts match ?",
                                   ['"' + q.replace('"', '""') + '"']).fetchall()
            except Exception:  # noqa: BLE001
                pass
            like = "%" + q + "%"
            rows += con.execute("select conversation_id from conversation_summaries where title like ? or preview like ?",
                                [like, like]).fetchall()
            agy = sorted({r[0] for r in rows})
        finally:
            con.close()
    json.dump({"claude": claude, "agy": agy, "archive": search_notes(a.get("archiveDir"), q)}, sys.stdout)


def main():
    a = json.loads(sys.argv[1])
    {"index": cmd_index, "search": cmd_search}[a["mode"]](a)


main()
