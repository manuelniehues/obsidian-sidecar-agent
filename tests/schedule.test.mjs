// Scheduled runs, cron, usage pace and terminal link candidates (src/schedule.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronNext, findPathCandidates, findWikilinks, ingestSchedule, newScheduleState, pendingSchedules, usagePace } from "../src/schedule.js";

const at = (s) => new Date(s).getTime(); // local time

test("cron: next run in local time", () => {
  assert.equal(cronNext("17 3 25 12 *", at("2026-11-03T17:00")), at("2026-12-25T03:17"));
  assert.equal(cronNext("*/5 * * * *", at("2026-11-03T17:02:30")), at("2026-11-03T17:05"));
  assert.equal(cronNext("57 8 * * 1-5", at("2026-11-06T09:00")), at("2026-11-09T08:57")); // Fri → Mon
  assert.equal(cronNext("0 9 1 * 0", at("2026-11-02T10:00")), at("2026-11-08T09:00")); // DoM OR DoW: next Sunday
  assert.equal(cronNext("0 12 * * 7", at("2026-11-03T10:00")), at("2026-11-08T12:00")); // 7 = Sunday
  assert.equal(cronNext("kaputt", 0), null);
  assert.equal(cronNext("61 * * * *", 0), null);
});

const use = (id, name, input, ts) => JSON.stringify({ timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const res = (id, toolUseResult, ts, isError = false) =>
  JSON.stringify({ timestamp: ts, toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] } });

test("schedule: cron jobs and wakeups from the session file", () => {
  const st = newScheduleState();
  const since = at("2026-11-03T16:00");
  const lines = [
    use("old", "CronCreate", { cron: "* * * * *", prompt: "vorher" }, "2026-11-03T14:00:00Z"),
    res("old", { id: "aaaa", nextFireAt: at("2026-11-03T15:01") }, "2026-11-03T14:00:01Z"),
    use("t1", "CronCreate", { cron: "17 3 25 12 *", prompt: "Weihnachten", recurring: false }, "2026-11-03T16:56:00Z"),
    res("t1", { id: "2a6fae30", humanSchedule: "17 3 25 12 *", recurring: false, nextFireAt: 1798165020000 }, "2026-11-03T16:56:00Z"),
    use("t2", "CronCreate", { cron: "7 * * * *", prompt: "stündlich prüfen" }, "2026-11-03T16:57:00Z"),
    res("t2", { id: "bbbb", recurring: true, nextFireAt: at("2026-11-03T18:07") }, "2026-11-03T16:57:00Z"),
    use("t3", "ScheduleWakeup", { delaySeconds: 3600, reason: "CI beobachten", prompt: "/loop x" }, "2026-11-03T16:58:00Z"),
    res("t3", { scheduledFor: at("2026-11-03T18:58"), clampedDelaySeconds: 3600 }, "2026-11-03T16:58:00Z"),
    use("t4", "CronDelete", { id: "nope" }, "2026-11-03T16:59:00Z"),
    res("t4", {}, "2026-11-03T16:59:00Z", true),
  ];
  for (const l of lines) ingestSchedule(st, l, since);
  let p = pendingSchedules(st, at("2026-11-03T18:00"));
  assert.deepEqual(
    p.map((x) => [x.kind, x.text]),
    [
      ["cron", "stündlich prüfen"],
      ["wakeup", "CI beobachten"],
      ["cron", "Weihnachten"],
    ],
    "calls before the process start are ignored, sorted by time",
  );
  // the recurring job moves on, the wakeup drops out once due
  p = pendingSchedules(st, at("2026-11-03T19:00"));
  assert.deepEqual(
    p.map((x) => [x.kind, x.at]),
    [
      ["cron", at("2026-11-03T19:07")],
      ["cron", 1798165020000],
    ],
  );
  ingestSchedule(st, use("t5", "CronDelete", { id: "bbbb" }, "2026-11-03T19:01:00Z"), since);
  ingestSchedule(st, res("t5", {}, "2026-11-03T19:01:00Z"), since);
  ingestSchedule(st, use("t6", "ScheduleWakeup", { delaySeconds: 60 }, "2026-11-03T19:02:00Z"), since);
  ingestSchedule(st, res("t6", { scheduledFor: at("2026-11-03T20:03") }, "2026-11-03T19:02:00Z"), since);
  ingestSchedule(st, use("t7", "ScheduleWakeup", { stop: true }, "2026-11-03T19:03:00Z"), since);
  ingestSchedule(st, res("t7", {}, "2026-11-03T19:03:00Z"), since);
  assert.deepEqual(
    pendingSchedules(st, at("2026-11-03T19:05")).map((x) => x.text),
    ["Weihnachten"],
    "CronDelete and a stopped wakeup remove their entries",
  );
  // recurring jobs end after 7 days
  ingestSchedule(st, use("t8", "CronCreate", { cron: "*/10 * * * *", prompt: "alle 10" }, "2026-11-03T19:10:00Z"), since);
  ingestSchedule(st, res("t8", { id: "cccc", recurring: true, nextFireAt: at("2026-11-03T19:20") }, "2026-11-03T19:10:00Z"), since);
  assert.ok(pendingSchedules(st, at("2026-11-09T12:00")).some((x) => x.text === "alle 10"));
  assert.ok(!pendingSchedules(st, at("2026-11-11T12:00")).some((x) => x.text === "alle 10"));
});

test("usage pace: projection at reset or time the limit is hit", () => {
  const H = 3600000;
  const now = at("2026-11-03T12:00");
  // 5 h window, 2.5 h elapsed, 20 % used → 40 % at reset
  assert.deepEqual(usagePace(20, now + 2.5 * H, 5 * H, now), { frac: 0.5, projected: 40 });
  // 1 h elapsed, 40 % used → limit after 2.5 h in total, i.e. in 1.5 h
  const p = usagePace(40, now + 4 * H, 5 * H, now);
  assert.equal(p.frac, 0.2);
  assert.equal(p.hitAt, now + 1.5 * H);
  // too early, nothing used or used up: elapsed share only
  assert.deepEqual(usagePace(5, now + 4.95 * H, 5 * H, now), { frac: 0.01 });
  assert.deepEqual(usagePace(0, now + 2.5 * H, 5 * H, now), { frac: 0.5 });
  assert.deepEqual(usagePace(100, now + 2.5 * H, 5 * H, now), { frac: 0.5 });
  assert.equal(usagePace(10, null, 5 * H, now), null);
});

test("terminal links: wikilinks and path candidates", () => {
  assert.deepEqual(findWikilinks("siehe [[AI AGENTS/Sidecar Agent/Sidecar Agent|Doku]] und [[Notiz#Abschnitt]]"), [
    { start: 6, end: 52, link: "AI AGENTS/Sidecar Agent/Sidecar Agent" },
    { start: 57, end: 76, link: "Notiz#Abschnitt" },
  ]);
  const line = "Geändert: AI AGENTS/Sidecar Agent/Sidecar Agent.md:12, dazu `src/panel-view.js` und https://x.de/a.md";
  const c = findPathCandidates(line);
  const first = c[0];
  assert.equal(line.slice(first.starts[0], first.end), "Geändert: AI AGENTS/Sidecar Agent/Sidecar Agent.md");
  assert.ok(first.starts.some((s) => line.slice(s, first.end) === "AI AGENTS/Sidecar Agent/Sidecar Agent.md"), "the real path is among the starts");
  assert.equal(line.slice(first.end, first.rangeEnd), ":12");
  assert.ok(c.some((x) => x.starts.some((s) => line.slice(s, x.end) === "src/panel-view.js")));
  assert.ok(!c.some((x) => x.starts.some((s) => line.slice(s, x.end).includes("://"))), "URLs are left to the web links");
  // a backticked folder
  const f = findPathCandidates("Ordner `AI AGENTS/Sidecar Agent/` angelegt");
  assert.ok(f.some((x) => x.starts.length === 1 && "Ordner `AI AGENTS/Sidecar Agent/` angelegt".slice(x.starts[0], x.end) === "AI AGENTS/Sidecar Agent/"));
  assert.deepEqual(findPathCandidates("nichts hier"), []);
});
