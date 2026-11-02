# Sidecar Agent – status line for Claude Code (plugin sessions only, passed in via --settings).
# Reads Claude's status JSON from stdin, stores the usage limits for the plugin
# (~/Library/Caches/sidecar-agent/claude-limits.json), the context window fill level per session
# (~/Library/Caches/sidecar-agent/claude-context/<session_id>.json) and prints a short line.
import json
import os
import sys
import time

try:
    data = json.load(sys.stdin)
except Exception:  # noqa: BLE001
    print("")
    sys.exit(0)

rl = data.get("rate_limits") or {}
out = os.path.expanduser("~/Library/Caches/sidecar-agent/claude-limits.json")
if rl:
    try:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = out + ".%d.tmp" % os.getpid()
        with open(tmp, "w") as f:
            json.dump({"at": int(time.time() * 1000), "session_id": data.get("session_id"), "rate_limits": rl}, f)
        os.replace(tmp, out)
    except Exception:  # noqa: BLE001
        pass

# Context window fill level of this session (input tokens of the last API response)
cw = data.get("context_window") or {}
sid = data.get("session_id")
if sid and cw:
    try:
        cdir = os.path.join(os.path.dirname(out), "claude-context")
        os.makedirs(cdir, exist_ok=True)
        cur = cw.get("current_usage")
        rec = {
            "at": int(time.time() * 1000),
            "used_percentage": cw.get("used_percentage"),
            "used_tokens": cw.get("total_input_tokens") if cur is not None else None,
            "size": cw.get("context_window_size"),
            "exceeds_200k": data.get("exceeds_200k_tokens"),
        }
        tmp = os.path.join(cdir, "%s.json.%d.tmp" % (sid, os.getpid()))
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, os.path.join(cdir, sid + ".json"))
    except Exception:  # noqa: BLE001
        pass

model = (data.get("model") or {}).get("display_name") or ""
parts = []
for key, label in (("five_hour", "5h"), ("seven_day", os.environ.get("SIDECAR_AGENT_WEEK_LABEL", "week"))):
    v = (rl.get(key) or {}).get("used_percentage")
    if v is not None:
        parts.append("%s %d %%" % (label, round(v)))
ctx = cw.get("used_percentage")
if ctx is not None:
    parts.append("%s %d %%" % (os.environ.get("SIDECAR_AGENT_CTX_LABEL", "ctx"), round(ctx)))
print(" · ".join([p for p in [model] + parts if p]))
