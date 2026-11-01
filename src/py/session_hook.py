# Sidecar Agent – SessionStart hook for Claude Code (plugin sessions only, passed in via --settings).
# Claude Code starts a new session with a new id on /clear (and switches on /resume inside Claude).
# This hook writes the current session id to the file named in SIDECAR_AGENT_SESSION_FILE (one file per
# panel terminal), so the plugin can follow the switch (reading view, tab title, resume after restart).
# Prints nothing, so nothing is added to Claude's context.
import json
import os
import sys
import time

try:
    data = json.load(sys.stdin)
    target = os.environ["SIDECAR_AGENT_SESSION_FILE"]
    sid = data.get("session_id")
    if sid:
        tmp = target + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"session_id": sid, "source": data.get("source"), "at": int(time.time() * 1000)}, f)
        os.replace(tmp, target)
except Exception:  # noqa: BLE001
    pass
sys.exit(0)
