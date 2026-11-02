// Helper scripts Claude Code runs in plugin sessions: state, session id, note context, status line.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { runPy, tmpDir } from "./helpers.mjs";

const hook = (env, input) => runPy("state_hook.py", { stdin: JSON.stringify(input), env });

test("state hook: busy → waiting → busy → done, idle reminder keeps the answer", () => {
  const f = path.join(tmpDir(), "state.json");
  const env = { SIDECAR_AGENT_STATE_FILE: f };
  const read = () => JSON.parse(fs.readFileSync(f, "utf8"));
  const r = hook(env, { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x" });
  assert.equal(r.stdout, "", "prints nothing (would end up in Claude's context)");
  assert.equal(read().state, "busy");
  hook(env, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(read().state, "waiting");
  assert.match(read().message, /permission/);
  hook(env, { hook_event_name: "PostToolUse", tool_name: "Bash" });
  assert.equal(read().state, "busy");
  const at = read().at;
  hook(env, { hook_event_name: "PostToolUse", tool_name: "Read" });
  assert.equal(read().at, at, "PostToolUse while busy does not rewrite the file");
  hook(env, { hook_event_name: "Stop", last_assistant_message: "Fertig." });
  assert.deepEqual([read().state, read().message], ["done", "Fertig."]);
  hook(env, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(read().message, "Fertig.");
  hook(env, { hook_event_name: "PermissionRequest", tool_name: "Write" });
  assert.equal(read().state, "waiting");
});

test("state hook without its file or with garbage does not fail", () => {
  runPy("state_hook.py", { stdin: "{" });
  runPy("state_hook.py", { stdin: JSON.stringify({ hook_event_name: "Stop" }), env: { SIDECAR_AGENT_STATE_FILE: "" } });
});

test("session hook writes the current id", () => {
  const f = path.join(tmpDir(), "session.json");
  runPy("session_hook.py", { stdin: JSON.stringify({ session_id: "neu", source: "clear" }), env: { SIDECAR_AGENT_SESSION_FILE: f } });
  assert.deepEqual(
    (({ session_id, source }) => ({ session_id, source }))(JSON.parse(fs.readFileSync(f, "utf8"))),
    { session_id: "neu", source: "clear" },
  );
});

test("context hook adds the open note and the selection", () => {
  const f = path.join(tmpDir(), "ctx.json");
  fs.writeFileSync(f, JSON.stringify({ enabled: true, path: "A/B.md", selection: "Satz" }));
  const out = runPy("context_hook.py", { stdin: "{}", env: { SIDECAR_AGENT_CONTEXT: f } }).stdout;
  assert.match(out, /<obsidian_context>/);
  assert.match(out, /A\/B\.md/);
  assert.match(out, /<selection>\nSatz\n<\/selection>/);
  fs.writeFileSync(f, JSON.stringify({ enabled: false, path: "A/B.md" }));
  assert.equal(runPy("context_hook.py", { stdin: "{}", env: { SIDECAR_AGENT_CONTEXT: f } }).stdout, "");
});

test("status line stores limits and context per session", () => {
  const home = tmpDir();
  const input = {
    session_id: "sess",
    model: { display_name: "Opus 5.5" },
    rate_limits: { five_hour: { used_percentage: 18, resets_at: 1793652600 }, seven_day: { used_percentage: 24, resets_at: 1793858400 } },
    context_window: { used_percentage: 41, total_input_tokens: 82000, context_window_size: 200000, current_usage: {} },
  };
  const out = runPy("statusline.py", { stdin: JSON.stringify(input), env: { HOME: home, SIDECAR_AGENT_WEEK_LABEL: "Woche", SIDECAR_AGENT_CTX_LABEL: "Kontext" } }).stdout.trim();
  assert.equal(out, "Opus 5.5 · 5h 18 % · Woche 24 % · Kontext 41 %");
  const cache = path.join(home, "Library", "Caches", "sidecar-agent");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, "claude-limits.json"), "utf8")).rate_limits.five_hour.used_percentage, 18);
  const ctx = JSON.parse(fs.readFileSync(path.join(cache, "claude-context", "sess.json"), "utf8"));
  assert.deepEqual([ctx.used_percentage, ctx.used_tokens, ctx.size], [41, 82000, 200000]);
});
