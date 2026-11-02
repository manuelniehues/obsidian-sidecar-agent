# Sidecar Agent – state hook for Claude Code (plugin sessions only, passed in via --settings).
# Registered for UserPromptSubmit, PostToolUse(Failure), PermissionRequest, Stop, StopFailure and Notification. Writes the session's
# state to the file named in SIDECAR_AGENT_STATE_FILE (one file per panel terminal), so the plugin can
# show "working / waiting for you / done" on the session tabs and notify when a session needs you.
#   busy     a prompt was sent or a tool finished (Claude keeps working)
#   waiting  Claude asks for a permission or an answer (PermissionRequest, Notification permission_prompt …)
#   done     the turn ended (Stop), failed (StopFailure) or Claude has been idle (Notification idle_prompt)
# Prints nothing, so nothing is added to Claude's context.
import json
import os
import sys
import time

try:
    data = json.load(sys.stdin)
except Exception:  # noqa: BLE001
    data = {}

target = os.environ.get("SIDECAR_AGENT_STATE_FILE")
event = data.get("hook_event_name") or ""
state = None
msg = ""
if event in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure"):
    state = "busy"
elif event == "PermissionRequest":
    state = "waiting"
    msg = "%s" % (data.get("tool_name") or "")
elif event == "Stop":
    state = "done"
    msg = data.get("last_assistant_message") or ""
elif event == "StopFailure":
    state = "done"
    msg = data.get("error") or data.get("message") or ""
elif event == "Notification":
    kind = data.get("notification_type") or ""
    msg = data.get("message") or ""
    if kind in ("permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "worker_permission_prompt"):
        state = "waiting"
    elif kind == "idle_prompt":
        state = "done"

if target and state:
    try:
        cur = {}
        try:
            with open(target) as f:
                cur = json.load(f)
        except Exception:  # noqa: BLE001
            pass
        # PostToolUse fires after every tool: only write when the state really changes
        if not (event.startswith("PostToolUse") and cur.get("state") == "busy"):
            rec = {
                "state": state,
                "event": event,
                "message": str(msg)[:400],
                "session_id": data.get("session_id"),
                "at": int(time.time() * 1000),
            }
            # an idle reminder after a finished turn must not hide the turn's own answer
            if event == "Notification" and state == "done" and cur.get("state") == "done":
                rec = None
            if rec:
                tmp = target + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(rec, f)
                os.replace(tmp, target)
    except Exception:  # noqa: BLE001
        pass
sys.exit(0)
