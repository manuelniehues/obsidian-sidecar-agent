// Sidecar Agent – logic without Obsidian: scheduled runs from Claude's session file, cron next-run,
// usage pace, and path/wikilink candidates in terminal lines.

// ---------------------------------------------------------------- cron
/** Parses one cron field into a Set of allowed values, or null for "*". */
function cronField(src, min, max) {
  if (src === "*" || src === "?") return null;
  const out = new Set();
  for (const part of src.split(",")) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron field "${src}"`);
    let lo = m[1] === "*" ? min : Number(m[1]);
    let hi = m[1] === "*" ? max : m[2] != null ? Number(m[2]) : m[3] != null ? max : lo;
    const step = m[3] != null ? Number(m[3]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron field "${src}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Next run of a 5-field cron expression ("M H DoM Mon DoW", local time) strictly after `from` (ms).
 * Day-of-month and day-of-week combine with OR when both are restricted, as in standard cron.
 * Returns null for an invalid expression or no match within about a year.
 */
export function cronNext(expr, from = Date.now()) {
  let f;
  try {
    const p = String(expr).trim().split(/\s+/);
    if (p.length !== 5) return null;
    f = { min: cronField(p[0], 0, 59), hour: cronField(p[1], 0, 23), dom: cronField(p[2], 1, 31), mon: cronField(p[3], 1, 12), dow: cronField(p[4], 0, 7) };
  } catch {
    return null;
  }
  if (f.dow?.has(7)) f.dow.add(0);
  const ok = (set, v) => !set || set.has(v);
  const dayOk = (d) => {
    const domOk = ok(f.dom, d.getDate());
    const dowOk = ok(f.dow, d.getDay());
    if (f.dom && f.dow) return domOk || dowOk;
    return domOk && dowOk;
  };
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 400 * 86400000;
  while (d.getTime() < limit) {
    if (!ok(f.mon, d.getMonth() + 1) || !dayOk(d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!ok(f.hour, d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!ok(f.min, d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d.getTime();
  }
  return null;
}

// ---------------------------------------------------------------- scheduled runs
export const RECURRING_MAX_MS = 7 * 86400000; // Claude Code expires recurring cron jobs after 7 days

export function newScheduleState() {
  return { uses: {}, crons: {}, wakeup: null };
}

/**
 * Feeds one line of a Claude session file into the schedule state. Only tool calls made at or
 * after `since` count (cron jobs and wakeups live in the Claude process and die with it).
 */
export function ingestSchedule(state, line, since = 0) {
  if (!line || (!line.includes("CronCreate") && !line.includes("CronDelete") && !line.includes("ScheduleWakeup") && !line.includes("tool_result"))) return;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const content = d?.message?.content;
  if (!Array.isArray(content)) return;
  const ts = Date.parse(d.timestamp) || 0;
  for (const c of content) {
    if (c?.type === "tool_use" && (c.name === "CronCreate" || c.name === "CronDelete" || c.name === "ScheduleWakeup")) {
      if (ts && ts < since) continue;
      state.uses[c.id] = { name: c.name, input: c.input || {}, ts };
    } else if (c?.type === "tool_result" && state.uses[c.tool_use_id]) {
      const u = state.uses[c.tool_use_id];
      delete state.uses[c.tool_use_id];
      if (c.is_error) continue;
      const r = d.toolUseResult || {};
      if (u.name === "CronCreate" && r.id) {
        state.crons[r.id] = {
          id: r.id,
          cron: u.input.cron || r.humanSchedule || "",
          prompt: u.input.prompt || "",
          recurring: r.recurring ?? u.input.recurring !== false,
          next: r.nextFireAt || cronNext(u.input.cron, u.ts || ts),
          created: u.ts || ts,
        };
      } else if (u.name === "CronDelete") {
        delete state.crons[u.input.id];
      } else if (u.name === "ScheduleWakeup") {
        state.wakeup = u.input.stop ? null : r.scheduledFor ? { at: r.scheduledFor, reason: u.input.reason || "", prompt: u.input.prompt || "" } : state.wakeup;
      }
    }
  }
}

/**
 * Pending runs at `now`, soonest first: [{kind: "cron"|"wakeup", at, recurring, cron, text}].
 * Runs that are due drop out (one-shot, wakeup) or move on to their next match (recurring).
 */
export function pendingSchedules(state, now = Date.now()) {
  for (const j of Object.values(state.crons)) {
    if (j.next && j.next > now) continue;
    if (!j.recurring || now - j.created > RECURRING_MAX_MS) {
      delete state.crons[j.id];
      continue;
    }
    j.next = cronNext(j.cron, now);
    if (!j.next || j.next - j.created > RECURRING_MAX_MS + 3600000) delete state.crons[j.id];
  }
  if (state.wakeup && state.wakeup.at <= now) state.wakeup = null;
  const out = Object.values(state.crons).map((j) => ({ kind: "cron", at: j.next, recurring: j.recurring, cron: j.cron, text: j.prompt }));
  if (state.wakeup) out.push({ kind: "wakeup", at: state.wakeup.at, recurring: false, cron: "", text: state.wakeup.reason || state.wakeup.prompt });
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- usage pace
/**
 * Pace of a usage window: `frac` is the elapsed share of the window (0..1). With enough data,
 * `projected` is the expected use at the reset (< 100) or `hitAt` the time the limit is reached.
 */
export function usagePace(used, resetsAt, windowMs, now = Date.now()) {
  if (!resetsAt || !windowMs) return null;
  const elapsed = Math.max(0, Math.min(windowMs, windowMs - (resetsAt - now)));
  const out = { frac: elapsed / windowMs };
  if (used == null || used < 1 || used >= 100 || elapsed < windowMs * 0.02) return out;
  const projected = (used * windowMs) / elapsed;
  if (projected < 100) out.projected = Math.round(projected);
  else out.hitAt = now + ((100 - used) * elapsed) / used;
  return out;
}

// ---------------------------------------------------------------- terminal links
const EXT =
  "md|markdown|canvas|base|pdf|png|jpe?g|gif|webp|svg|heic|tiff?|bmp|avif|mp3|m4a|wav|ogg|flac|mp4|mov|webm|m4v|txt|csv|tsv|json|jsonl|ya?ml|toml|py|js|mjs|cjs|ts|sh|zsh|bash|html?|css|docx?|xlsx?|pptx?|zip|log|plist|xml|obj|mtl|sql|db|ini|conf";
const EXT_RE = new RegExp(`\\.(?:${EXT})(?=$|[^A-Za-z0-9_\\-])`, "gi");
const BOUNDARY = /[\s"'`(<[=]/;

/**
 * Wikilinks in a line: [{start, end, link}] with `link` the part before "|" (heading kept).
 */
export function findWikilinks(text) {
  const out = [];
  const re = /\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, link: m[1].trim() });
  return out;
}

/**
 * Path candidates in a line, grouped by where they end: [{end, rangeEnd, starts: [start…]}].
 * A path may contain spaces, so each end comes with several possible starts (leftmost first);
 * the caller keeps the first one that exists. A trailing ":12" or ":12:3" belongs to the link, not the path.
 * Backticked text containing "/" is a candidate as a whole (also folders).
 */
export function findPathCandidates(text) {
  const out = [];
  if (!text || (!text.includes("/") && !text.includes("."))) return out;
  EXT_RE.lastIndex = 0;
  let m;
  while ((m = EXT_RE.exec(text))) {
    const end = m.index + m[0].length;
    const ln = text.slice(end).match(/^:\d+(?::\d+)?/);
    const rangeEnd = end + (ln ? ln[0].length : 0);
    const starts = [];
    for (let s = Math.max(0, end - 300); s < m.index; s++) {
      if (s > 0 && !BOUNDARY.test(text[s - 1])) continue;
      if (BOUNDARY.test(text[s])) continue;
      const cand = text.slice(s, end);
      if (/["'`<>\n]|:\/\//.test(cand) || cand.startsWith("[[")) continue;
      starts.push(s);
    }
    if (starts.length) out.push({ end, rangeEnd, starts });
  }
  const bt = /`([^`\n]{2,300})`/g;
  while ((m = bt.exec(text))) {
    const inner = m[1].trim();
    if (!inner.includes("/") || inner.includes("://") || /\s{2,}|[|<>]/.test(inner)) continue;
    const s = m.index + 1 + m[1].indexOf(inner);
    const end = s + inner.length;
    if (out.some((c) => c.end === end && c.starts.includes(s))) continue;
    out.push({ end, rangeEnd: end, starts: [s] });
  }
  return out;
}
