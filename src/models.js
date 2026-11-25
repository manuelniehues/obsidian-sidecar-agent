// Sidecar Agent – model ordering by capability (highest first, then higher effort first), Antigravity and Claude.

const GEMINI_TIERS = {
  carbon: 90,
  argon: 80,
  neon: 70,
  hydrogen: 60,
  ultra: 55,
  pro: 50,
  flash: 40,
  lite: 30,
};

const CLAUDE_TIERS = {
  opus: 90,
  sonnet: 70,
  haiku: 50,
};

function effortRank(id, label) {
  const s = `${id} ${label}`.toLowerCase();
  if (/(?:^|[-(\s])xhigh(?:$|[-)\s])/.test(s)) return 4;
  if (/(?:^|[-(\s])high(?:$|[-)\s])/.test(s)) return 3;
  if (/(?:^|[-(\s])medium(?:$|[-)\s])/.test(s)) return 2;
  if (/(?:^|[-(\s])low(?:$|[-)\s])/.test(s)) return 1;
  return 0;
}

function modelKey([id, label]) {
  const raw = `${id} ${label}`.toLowerCase();
  const isOrchestrator = raw.includes("orchestrator");
  const isClaude = raw.includes("claude");
  const isGemini = !isOrchestrator && raw.includes("gemini");
  const family = isGemini ? 0 : isOrchestrator ? 1 : isClaude ? 2 : 3;

  let version = 0;
  if (isGemini) {
    const m = id.toLowerCase().match(/gemini-(\d+(?:\.\d+)?)/);
    if (m) version = parseFloat(m[1]);
  } else if (isClaude) {
    const m = id.toLowerCase().match(/(\d+)[.-](\d+)/);
    if (m) version = parseFloat(`${m[1]}.${m[2]}`);
  } else if (!isOrchestrator) {
    const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)/);
    if (m) version = parseFloat(m[1]);
  }

  let tier = 20;
  const table = isClaude ? CLAUDE_TIERS : GEMINI_TIERS;
  for (const [name, rank] of Object.entries(table)) {
    if (new RegExp(`(?:^|[-(\\s])${name}(?:$|[-)\\s])`).test(raw)) {
      tier = Math.max(tier, rank);
    }
  }

  return [family, version, tier, effortRank(id, label), String(label || id)];
}

/** Sorts Antigravity models ([id, label]) by capability tier (highest first) and effort (high before medium/low). */
export function sortAgyModels(models) {
  return [...(models || [])].sort((a, b) => {
    const ka = modelKey(a);
    const kb = modelKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0]; // family asc: Gemini, Orchestrator, Claude, other
    if (ka[1] !== kb[1]) return kb[1] - ka[1]; // version desc
    if (ka[2] !== kb[2]) return kb[2] - ka[2]; // tier desc
    if (ka[3] !== kb[3]) return kb[3] - ka[3]; // effort desc
    return ka[4].localeCompare(kb[4]);
  });
}

// ---------------------------------------------------------------- Claude Code
// Claude Code takes aliases (fable, opus, opusplan, sonnet, haiku) or full ids (claude-opus-5-5); the effort is
// a separate option (--effort), so the pickers offer each model as a "high" and a "medium" variant.
// Names always carry the version ("Opus 5.5"): an alias gets the newest version seen in the session
// transcripts, at least the one known at release time.
const CLAUDE_FAMILIES = { fable: 100, opus: 90, sonnet: 70, haiku: 50 };
const KNOWN_VERSIONS = { fable: "5.2", opus: "5.5", sonnet: "5.5", haiku: "5.5" };
export const CLAUDE_VARIANT_EFFORTS = ["high", "medium"];
const FULL_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+)-(\d+)(.*)$/i;

const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const num = (v) => {
  const [a, b] = String(v).split(".").map(Number);
  return (a || 0) * 1000 + (b || 0);
};

/** Newest version per family ({ opus: "5.5", … }) from model ids seen in transcripts, at least the known ones. */
export function claudeFamilyVersions(ids = []) {
  const out = { ...KNOWN_VERSIONS };
  for (const id of ids) {
    const m = String(id || "").match(FULL_ID);
    if (!m) continue;
    const f = m[1].toLowerCase();
    const v = `${m[2]}.${m[3]}`;
    if (!out[f] || num(v) > num(out[f])) out[f] = v;
  }
  return out;
}

/** Family, version and the rest of a Claude model id or alias; null for anything else. */
function parseClaude(id, versions = KNOWN_VERSIONS) {
  const s = String(id || "").trim();
  const m = s.match(FULL_ID);
  if (m) return { family: m[1].toLowerCase(), version: `${m[2]}.${m[3]}`, rest: m[4] || "" };
  const a = s.toLowerCase();
  if (a === "opusplan") return { family: "opus", version: versions.opus || "", rest: "", plan: true, alias: true };
  if (CLAUDE_FAMILIES[a]) return { family: a, version: versions[a] || "", rest: "", alias: true };
  return null;
}

/** Sorts Claude models ([id, label]) by capability: Fable, Opus, Opus plan, Sonnet, Haiku, others; newer first. */
export function sortClaudeModels(models, versions = KNOWN_VERSIONS) {
  const key = (id) => {
    const p = parseClaude(id, versions);
    if (!p) return [0, 0, 0];
    return [CLAUDE_FAMILIES[p.family] - (p.plan ? 5 : 0), num(p.version), p.alias ? 2 : p.rest ? 0 : 1]; // alias before the same full id
  };
  return [...(models || [])].sort((a, b) => {
    const ka = key(a[0]);
    const kb = key(b[0]);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return String(a[1] || a[0]).localeCompare(String(b[1] || b[0]));
  });
}

/** "opus" → "Opus 5.5", "opusplan" → "Opus 5.5 Plan", "claude-opus-5-5-high" → "Opus 5.5 · High". */
export function claudeModelName(id, versions = KNOWN_VERSIONS) {
  const p = parseClaude(id, versions);
  if (!p) return String(id || "").replace(/^claude-/, "");
  let name = [cap(p.family), p.version].filter(Boolean).join(" ");
  if (p.plan) name += " Plan";
  const rest = p.rest.replace(/^-/, "");
  if (/^(low|medium|high|xhigh|max)$/i.test(rest)) name += ` · ${cap(rest.toLowerCase())}`;
  else if (rest) name += ` ${rest}`;
  return name;
}

/** Picker entries for Claude: each model with high and medium effort ({ value, model, effort, label }). */
export function claudeVariants(models, versions = KNOWN_VERSIONS) {
  const out = [];
  for (const [id] of sortClaudeModels(models, versions)) {
    for (const effort of CLAUDE_VARIANT_EFFORTS) out.push({ value: `${id}|${effort}`, model: id, effort, label: `${claudeModelName(id, versions)} · ${cap(effort)}` });
  }
  return out;
}

/** "opus|high" → { model: "opus", effort: "high" }; a plain id keeps the effort undefined. */
export function splitVariant(value) {
  const [model, effort] = String(value || "").split("|");
  return effort === undefined ? { model } : { model, effort };
}
