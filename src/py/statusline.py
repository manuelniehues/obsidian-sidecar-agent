# Sidecar Agent – status line for Claude Code (plugin sessions only, passed in via --settings).
# Reads Claude's status JSON from stdin, stores the usage limits for the plugin
# (~/Library/Caches/sidecar-agent/claude-limits.json) and prints a short line.
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

model = (data.get("model") or {}).get("display_name") or ""
parts = []
for key, label in (("five_hour", "5h"), ("seven_day", os.environ.get("SIDECAR_AGENT_WEEK_LABEL", "week"))):
    v = (rl.get(key) or {}).get("used_percentage")
    if v is not None:
        parts.append("%s %d %%" % (label, round(v)))
print(" · ".join([p for p in [model] + parts if p]))
