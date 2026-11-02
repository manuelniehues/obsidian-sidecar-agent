// Sidecar Agent – "What's new": the CHANGELOG.md sections between two versions (no Obsidian dependency, tested).

/** Compare "1.5.2" style versions: <0, 0, >0. */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Sections "## x.y.z" of the changelog with from < version <= to, newest first:
 * [{version, body}]. Several versions at once when the user skipped updates.
 */
export function changelogSince(md, from, to) {
  const out = [];
  const parts = String(md || "").split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const version = (nl < 0 ? part : part.slice(0, nl)).trim();
    if (!/^\d+(\.\d+)*$/.test(version)) continue;
    if (compareVersions(version, from) > 0 && compareVersions(version, to) <= 0) out.push({ version, body: (nl < 0 ? "" : part.slice(nl + 1)).trim() });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}
