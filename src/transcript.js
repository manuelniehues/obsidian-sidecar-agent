// Sidecar Agent – parsing of session files and terminal text, without any Obsidian dependency.
// Kept separate so the tests (tests/*.test.mjs) can check it against sample files and, before a release,
// against the real local sessions (scripts/compat-check.mjs): Claude Code's session format is not
// documented and changes with its frequent updates.

/** Timestamp (seconds, milliseconds or ISO) to milliseconds. */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const ts = Date.parse(v);
  return Number.isNaN(ts) ? null : ts;
}

/** Turns "resets 4:20pm (Europe/Berlin)" or "resets Oct 24, 10am" into a time after limitAt. */
export function parseResetText(text, limitAt) {
  const m = text.match(/resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") h += 12;
  const d = new Date(limitAt);
  if (m[1]) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
    if (mon >= 0) d.setMonth(mon, Number(m[2]));
  }
  d.setHours(h, Number(m[4] || 0), 0, 0);
  if (d.getTime() < limitAt) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Last usage-limit error at the end of a Claude session file (lines as strings), or null when there is
 * none or the conversation went on afterwards (a new question or a real answer).
 */
export function findUsageLimit(lines) {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"apiError":"usage_limit_reached"')) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  let rec;
  try {
    rec = JSON.parse(lines[idx]);
  } catch {
    return null;
  }
  for (let i = idx + 1; i < lines.length; i++) {
    try {
      const d = JSON.parse(lines[i]);
      if ((d.type === "user" && !d.isMeta) || (d.type === "assistant" && !d.isApiErrorMessage && !String(lines[i]).includes("usage_limit_reached"))) return null;
    } catch {
      // incomplete line
    }
  }
  return rec;
}

/**
 * End of an Antigravity transcript (brain/<id>/.system_generated/logs/transcript.jsonl):
 * {at, used_tokens, final, text} or null. used_tokens = input_tokens + cache_read_tokens of the last model
 * response (agy reports no window size). final = the last step is a finished model response without tool
 * calls, i.e. the answer is complete and agy waits for the user.
 */
export function agyTail(text, mtime = 0) {
  const lines = String(text).split("\n");
  let rec = null;
  let last;
  const started = new Set();
  const finished = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue; // the first line of a chunk may be cut off
    }
    // agy compacts the conversation after an answer: such a step is no activity and hides nothing
    if (d.type === "CHECKPOINT" || d.type === "CONVERSATION_HISTORY") continue;
    if (last === undefined) last = d;
    // Background tasks: agy continues by itself when one finishes. The step keeps status RUNNING in the
    // transcript even afterwards, the end comes as a system message naming the task id. A task agy cancels
    // itself ends the same way, the system message may arrive late, so its own "cancelled." counts too.
    const c = typeof d.content === "string" ? d.content : "";
    let m = c.match(/running as a background task with task id: (\S+)/);
    if (m) started.add(m[1]);
    for (m of c.matchAll(/Task(?: id)? "([^"]+)" (?:finished|was canceled|cancelled)/g)) finished.add(m[1]);
    if (!rec && d.input_tokens != null) rec = { at: Date.parse(d.created_at) || mtime, used_tokens: (d.input_tokens || 0) + (d.cache_read_tokens || 0) };
  }
  if (!last) return rec;
  const background = [...started].filter((id) => !finished.has(id)).length;
  const final = last.type === "PLANNER_RESPONSE" && last.status === "DONE" && !(last.tool_calls && last.tool_calls.length) && !background;
  return { ...(rec || { at: mtime, used_tokens: 0 }), final, background, text: final ? String(last.content || "") : "" };
}

// ------------------------------------------------------------------ reading view (Claude session file)

/** Strip appended context blocks from user messages. */
export function cleanUser(text) {
  let x = String(text || "");
  const cut = x.search(/\n\s*<(obsidian_context|system-reminder)\b/);
  if (cut > 0) x = x.slice(0, cut);
  return x.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function toolSummary(b) {
  const i = b.input || {};
  const d = i.description || i.command || i.file_path || i.pattern || i.query || i.url || i.prompt || "";
  return `${b.name}${d ? ": " + String(d).replace(/\s+/g, " ").slice(0, 140) : ""}`;
}

/**
 * Sort one line of a Claude session file into turns ({key, role:"user", text} or
 * {key, role:"assistant", parts:[{kind:"text"|"tool"|"error", text}]}). Returns true if turns changed.
 */
export function ingestLine(turns, line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  if (d.isSidechain || d.isMeta) return false;
  const c = d.message?.content;
  if (d.type === "user") {
    if (typeof c === "string") {
      const text = cleanUser(c);
      if (!text || text.startsWith("<")) return false;
      turns.push({ key: d.uuid, role: "user", text, sig: "" });
      return true;
    }
    if (Array.isArray(c)) {
      const texts = c
        .filter((b) => b.type === "text")
        .map((b) => cleanUser(b.text))
        .filter((x) => x && !x.startsWith("<"));
      if (!texts.length) return false; // tool results
      turns.push({ key: d.uuid, role: "user", text: texts.join("\n\n"), sig: "" });
      return true;
    }
    return false;
  }
  if (d.type === "assistant" && Array.isArray(c)) {
    let last = turns[turns.length - 1];
    if (!last || last.role !== "assistant") {
      last = { key: d.uuid, role: "assistant", parts: [], sig: "" };
      turns.push(last);
    }
    let added = false;
    for (const b of c) {
      if (b.type === "text" && b.text?.trim()) {
        last.parts.push({ kind: "text", text: b.text });
        added = true;
      } else if (b.type === "tool_use") {
        last.parts.push({ kind: "tool", text: toolSummary(b) });
        added = true;
      }
    }
    if (d.isApiErrorMessage) {
      last.parts.push({ kind: "error", text: c.map((b) => b.text || "").join(" ") });
      added = true;
    }
    return added;
  }
  return false;
}

/**
 * Did a session read or edit the vault file? files: the vault-relative paths the indexer collected.
 * Exact match, or a stored path with at least one folder that ends the file's path (shell commands that
 * ran in a subfolder: "Second Brain/log.md"). Bare names like "index.md" are too ambiguous.
 */
export function touchesFile(files, filePath) {
  if (!filePath || !files?.length) return false;
  const p = filePath.normalize("NFC");
  return files.some((f) => f === p || (f.includes("/") && p.endsWith("/" + f)));
}

// ------------------------------------------------------------------ terminal screen

// Claude Code's messages when it switches to paid usage after a limit (from its own message list).
const CREDITS_RE = /\b(?:You're now|Now) using (?:usage credits|your usage allocation|credits|extra usage)\b/i;

/**
 * Does Claude's status area show that it now runs on usage credits? Only the rows below the input box
 * count (Claude's footer); the same words in the conversation above must not trigger it.
 * rows: the visible terminal lines as plain text, top to bottom.
 */
export function creditsShown(rows) {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/─{8,}/.test(rows[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) start = Math.max(0, rows.length - 3);
  return rows.slice(start).some((r) => CREDITS_RE.test(r));
}

/** Decode the payload of an OSC 52 clipboard sequence ("c;<base64>"); null for queries or invalid data. */
export function osc52Text(data) {
  const i = String(data).indexOf(";");
  if (i < 0) return null;
  const b64 = data.slice(i + 1);
  if (!b64 || b64 === "?") return null;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ task list (progress)

/**
 * Follows Claude Code's task list in a session file (TaskCreate / TaskUpdate, older TodoWrite).
 * feed(line) per line, in order; progress() gives the current batch: the tasks created since the last
 * moment all earlier ones were finished, so an old, completed list does not count for a new job.
 */
export class TaskTracker {
  constructor() {
    this.tasks = new Map(); // id -> {id, subject, active, status}
    this.batch = []; // ids of the current batch, in creation order
    this.pending = new Map(); // tool_use id -> TaskCreate input, until the result names the task id
    this.seq = 0;
  }

  /** Returns true when the task list changed. */
  feed(line) {
    // Cheap pre-check: only lines with task tools, or results while a TaskCreate waits for its id
    if (!line.includes("Task") && !line.includes("TodoWrite") && !(this.pending.size && line.includes("tool_result"))) return false;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    // Only the conversation itself: Claude Code repeats earlier messages in internal records (api-request-blob)
    if (d.isSidechain || (d.type !== "assistant" && d.type !== "user")) return false;
    const c = d.message?.content;
    if (!Array.isArray(c)) return false;
    let changed = false;
    for (const b of c) {
      if (b.type === "tool_use" && b.name === "TaskCreate") this.pending.set(b.id, b.input || {});
      else if (b.type === "tool_use" && b.name === "TaskUpdate") changed = this.update(b.input || {}) || changed;
      else if (b.type === "tool_use" && b.name === "TodoWrite") changed = this.todoWrite(b.input?.todos) || changed;
      else if (b.type === "tool_result" && this.pending.has(b.tool_use_id)) {
        const input = this.pending.get(b.tool_use_id);
        this.pending.delete(b.tool_use_id);
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        const m = text.match(/Task #(\w+) created/) || [null, d.toolUseResult?.task?.id];
        if (m[1]) changed = this.create(String(m[1]), input) || changed;
      }
    }
    return changed;
  }

  create(id, input) {
    if (this.batch.length && this.batch.every((x) => this.done(this.tasks.get(x)))) this.batch = [];
    this.tasks.set(id, { id, subject: input.subject || "", active: input.activeForm || "", status: "pending" });
    this.batch.push(id);
    return true;
  }

  update(input) {
    const t = this.tasks.get(String(input.taskId));
    if (!t) return false;
    if (input.status) t.status = input.status;
    if (input.subject) t.subject = input.subject;
    if (input.activeForm) t.active = input.activeForm;
    if (t.status === "deleted") this.batch = this.batch.filter((x) => x !== t.id);
    return true;
  }

  /** Older Claude Code versions: TodoWrite always sends the complete list. */
  todoWrite(todos) {
    if (!Array.isArray(todos)) return false;
    this.batch = [];
    this.tasks.clear();
    todos.forEach((td, i) => {
      const id = `todo-${i}`;
      this.tasks.set(id, { id, subject: td.content || "", active: td.activeForm || "", status: td.status || "pending" });
      this.batch.push(id);
    });
    return true;
  }

  done(t) {
    return !t || t.status === "completed" || t.status === "deleted";
  }

  /** {total, done, current, tasks:[{subject, status}]} or null without a list of at least two steps. */
  progress() {
    const tasks = this.batch.map((id) => this.tasks.get(id)).filter(Boolean);
    if (tasks.length < 2) return null;
    const cur = tasks.find((t) => t.status === "in_progress");
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.status === "completed").length,
      current: cur ? cur.active || cur.subject : "",
      tasks: tasks.map((t) => ({ subject: t.subject, status: t.status })),
    };
  }
}

// ------------------------------------------------------------------ background jobs and subagents (progress)

const BG_TOOLS = new Set(["Bash", "PowerShell", "Monitor", "Workflow"]);
const JOB_DONE = new Set(["completed", "complete", "done", "failed", "error", "killed", "cancelled", "canceled", "stopped", "exited", "finished"]);

/** Short text for a tool call: its description, else a file name, pattern or the start of a command. */
export function toolLabel(name, input) {
  const i = input || {};
  const base = (p) => String(p).split("/").filter(Boolean).pop() || String(p);
  const v = i.description || (i.file_path && base(i.file_path)) || (i.path && base(i.path)) || i.pattern || i.query || i.url || i.command || i.prompt || "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

/**
 * How long a background command waits before Claude hears from it again, read from the command itself:
 *   {seconds, exact: true}   a plain "sleep N" (optionally followed by the check): due after N seconds
 *   {seconds, exact: false}  a loop "for … in $(seq a b)" with sleeps inside, or "timeout N": at the latest after that
 *   {every}                  a while/until loop with sleeps: checks every N seconds, no end known
 * null when the command does not wait in a recognisable way.
 */
export function waitEstimate(command) {
  const c = String(command || "");
  const sleeps = [...c.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)(m)?\b/g)].reduce((a, m) => a + Number(m[1]) * (m[2] ? 60 : 1), 0);
  const tmo = c.match(/^\s*timeout\s+(\d+)\b/);
  const seq = c.match(/\bfor\s+\w+\s+in\s+\$\(seq\s+(\d+)(?:\s+(\d+))?\)/);
  if (seq && sleeps) {
    const n = seq[2] ? Number(seq[2]) - Number(seq[1]) + 1 : Number(seq[1]);
    return { seconds: Math.max(1, n) * sleeps, exact: false, every: sleeps };
  }
  if (tmo) return { seconds: Number(tmo[1]), exact: false };
  if (/\b(?:while|until)\b/.test(c) && sleeps) return { every: sleeps };
  const m = c.match(/^\s*sleep\s+(\d+(?:\.\d+)?)(m)?\s*(?:$|;|&&|\n)/);
  if (m && !/\b(?:for|while|until)\b/.test(c)) return { seconds: sleeps, exact: true };
  return null;
}

/**
 * Follows the background work a Claude session started (session file, main conversation only):
 *   bash   Bash with run_in_background, or a command Claude moved to the background after its timeout
 *   agent  Agent / Task subagents, foreground (until their result) and background (until their task-notification)
 *   monitor / other tools that hand back a background task id
 * Finished by a <task-notification> with a final status, TaskStop/KillShell, or clearAll() when Claude's Stop
 * hook reports no running background task. jobs() gives the running ones in start order.
 */
export class BackgroundTracker {
  constructor() {
    this.uses = new Map(); // tool_use id -> {name, input, at}
    this.list = new Map(); // key -> job {key, kind, label, startedAt, taskId, agentId, toolUseId}
  }

  /** Returns true when the set of running jobs changed. */
  feed(line) {
    if (!line.includes("tool_use") && !line.includes("task-notification") && !line.includes("toolUseResult")) return false;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    if (d.isSidechain || d.type === "api-request-blob" || d.type === "api-request" || d.type === "api-request-shape") return false;
    const at = toMs(d.timestamp) || Date.now();
    let changed = false;
    // Notifications arrive as queue operations, queued-command attachments or plain user text
    const raw = typeof d.content === "string" ? d.content : d.attachment?.prompt || (typeof d.message?.content === "string" ? d.message.content : "");
    if (raw && raw.includes("<task-notification>")) changed = this.notify(raw) || changed;
    const c = d.message?.content;
    if (!Array.isArray(c)) return changed;
    for (const b of c) {
      if (b.type === "tool_use") {
        this.uses.set(b.id, { name: b.name, input: b.input || {}, at });
        if (b.name === "Agent" || b.name === "Task") {
          this.list.set(b.id, { key: b.id, kind: "agent", label: b.input?.description || toolLabel(b.name, b.input), startedAt: at, toolUseId: b.id });
          changed = true;
        } else if ((b.name === "TaskStop" || b.name === "KillShell") && (b.input?.task_id || b.input?.shell_id)) {
          changed = this.finish(String(b.input.task_id || b.input.shell_id)) || changed;
        }
      } else if (b.type === "tool_result") {
        changed = this.result(b, d.toolUseResult, at) || changed;
      } else if (b.type === "text" && b.text?.includes("<task-notification>")) {
        changed = this.notify(b.text) || changed;
      }
    }
    return changed;
  }

  result(b, r, at) {
    const use = this.uses.get(b.tool_use_id);
    this.uses.delete(b.tool_use_id);
    const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text || "").join("\n") : "";
    const agent = this.list.get(b.tool_use_id);
    if (agent) {
      if (r?.isAsync && r.agentId && !b.is_error) {
        agent.agentId = String(r.agentId);
        agent.taskId = agent.agentId;
        return false;
      }
      const m = text.match(/agentId: (\w+)/);
      if (m && /launched|background/i.test(text) && !b.is_error) {
        agent.agentId = agent.taskId = m[1];
        return false;
      }
      this.list.delete(b.tool_use_id); // a foreground subagent ends with its result
      return true;
    }
    if (!use || b.is_error || !BG_TOOLS.has(use.name)) return false;
    // Only Claude Code's own wording at the very start: a command's output may quote the same words
    const m = text.match(/^(?:Command running in background with ID: (\w+)|Command did not complete[^\n]*?moved to the background \(ID: (\w+)\)|Monitor started[^\n]*?ID: (\w+))/);
    const id = r?.backgroundTaskId || (use.name !== "Bash" && typeof r?.taskId === "string" ? r.taskId : null) || m?.[1] || m?.[2] || m?.[3];
    if (!id) return false;
    const kind = use.name === "Bash" ? "bash" : use.name === "Monitor" ? "monitor" : "other";
    const wait = use.name === "Bash" || use.name === "PowerShell" ? waitEstimate(use.input?.command) : null;
    this.list.set(String(id), { key: String(id), kind, label: toolLabel(use.name, use.input) || use.name, startedAt: use.at || at, taskId: String(id), wait });
    return true;
  }

  notify(text) {
    let changed = false;
    const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
    let m;
    while ((m = re.exec(text))) {
      const id = m[1].match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1];
      const status = (m[1].match(/<status>\s*([^<\s]+)\s*<\/status>/)?.[1] || "").toLowerCase();
      if (id && JOB_DONE.has(status)) changed = this.finish(id) || changed;
    }
    return changed;
  }

  finish(id) {
    for (const [k, j] of this.list) {
      if (j.taskId === id || k === id) {
        this.list.delete(k);
        return true;
      }
    }
    return false;
  }

  /** Background jobs only (foreground subagents end with the turn anyway). */
  clearBackground() {
    let changed = false;
    for (const [k, j] of this.list) {
      if (j.taskId) {
        this.list.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  jobs() {
    return [...this.list.values()].sort((a, b) => a.startedAt - b.startedAt);
  }
}

/**
 * Reads a subagent transcript (<session>/subagents/agent-<id>.jsonl): number of tool calls and the last one.
 * feed(line) per line; state() gives {steps, last}.
 */
export class SubagentTail {
  constructor() {
    this.ids = new Set();
    this.last = "";
  }

  feed(line) {
    if (!line.includes("tool_use")) return false;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    if (d.type !== "assistant" || !Array.isArray(d.message?.content)) return false;
    let changed = false;
    for (const b of d.message.content) {
      if (b.type !== "tool_use" || this.ids.has(b.id)) continue;
      this.ids.add(b.id);
      const label = toolLabel(b.name, b.input);
      this.last = label ? `${b.name}: ${label}` : b.name;
      changed = true;
    }
    return changed;
  }

  state() {
    return { steps: this.ids.size, last: this.last };
  }
}
