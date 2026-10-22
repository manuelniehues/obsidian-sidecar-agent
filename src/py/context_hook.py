# Sidecar Agent – UserPromptSubmit hook for Claude Code (plugin sessions only, passed in via --settings).
# Silently appends the note currently shown in Obsidian (and a selection in it) to every message.
# Source: the JSON file named in SIDECAR_AGENT_CONTEXT, which the plugin rewrites whenever the
# active note changes (one file per vault). Whatever this prints is added to Claude's context.
import json
import os
import sys

try:
    sys.stdin.read()
except Exception:  # noqa: BLE001
    pass

try:
    with open(os.environ["SIDECAR_AGENT_CONTEXT"]) as f:
        ctx = json.load(f)
except Exception:  # noqa: BLE001
    sys.exit(0)

if not ctx.get("enabled") or not ctx.get("path"):
    sys.exit(0)

lines = [
    "<obsidian_context>",
    "Note currently open in Obsidian: %s (relative to the vault). Only read it if it is relevant to the request." % ctx["path"],
]
sel = (ctx.get("selection") or "").strip()
if sel:
    lines.append("Selected text in this note:\n<selection>\n%s\n</selection>" % sel[:4000])
lines.append("</obsidian_context>")
print("\n".join(lines))
