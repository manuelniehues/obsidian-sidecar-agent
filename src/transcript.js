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
    if (last === undefined) last = d;
    // Background tasks: agy continues by itself when one finishes. The step keeps status RUNNING in the
    // transcript even afterwards, the end comes as a system message naming the task id.
    const c = typeof d.content === "string" ? d.content : "";
    let m = c.match(/running as a background task with task id: (\S+)/);
    if (m) started.add(m[1]);
    for (m of c.matchAll(/Task id "([^"]+)" finished/g)) finished.add(m[1]);
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
