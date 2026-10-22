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
from datetime import datetime

CACHE_VERSION = 4


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


LINE_RE = {
    "title": re.compile(rb'^[^\n]*"(?:custom-title|ai-title)"[^\n]*$', re.M),
    "last": re.compile(rb'^[^\n]*"type":"last-prompt"[^\n]*$', re.M),
    "user": re.compile(rb'^[^\n]*"type":"user"[^\n]*$', re.M),
    "ts": re.compile(rb'"timestamp":"([^"]+)"'),
    "cwd": re.compile(rb'"cwd":"((?:[^"\\]|\\.)*)"'),
    "model": re.compile(rb'"model":"([A-Za-z0-9.\-\[\]_:]+)"'),
}


def parse_claude(path):
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
        if s.startswith("<") or s.startswith("Caveat:") or s.startswith("[Request interrupted"):
            continue
        users += 1
        if not first:
            first = clean_prompt(s)
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


def agy_list(db, vault):
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
        if not any(u.rstrip("/") == vault_uri for u in uris):
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


def cmd_index(a):
    cache_file = a["cache"]
    try:
        with open(cache_file, "r", encoding="utf-8") as f:
            cache = json.load(f)
        if cache.get("v") != CACHE_VERSION:
            cache = {}
    except Exception:  # noqa: BLE001
        cache = {}
    claude = scan_dir(a.get("claudeDir"), ".jsonl", parse_claude, cache.get("claude", {}))
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        tmp = cache_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": CACHE_VERSION, "claude": claude}, f, ensure_ascii=False)
        os.replace(tmp, cache_file)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("cache not writable: %s\n" % e)
    try:
        agy = agy_list(a.get("agyDb"), a["vault"])
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("agy: %s\n" % e)
        agy = []
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
    hits = []
    q = query.lower().encode("utf-8")
    suffix = glob.lstrip("*")
    for name in os.listdir(directory):
        if name.endswith(suffix):
            with open(os.path.join(directory, name), "rb") as f:
                if q in f.read().lower():
                    hits.append(name)
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
    json.dump({"claude": claude, "agy": agy}, sys.stdout)


def main():
    a = json.loads(sys.argv[1])
    {"index": cmd_index, "search": cmd_search}[a["mode"]](a)


main()
