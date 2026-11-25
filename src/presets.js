// Sidecar Agent – standard tasks
/** Menu title of a standard task: its name, otherwise the start of its first message. */
export function presetLabel(p) {
  const text = (p.name || "").trim() || String(p.initialPrompt || "").trim().split("\n")[0];
  return text.length > 50 ? `${text.slice(0, 50)}…` : text;
}

/** The fields of a standard task, taken from the values of the dialog. */
export function presetFromForm(v) {
  const p = { name: v.name, agent: v.agent, model: v.model, effort: v.effort, initialPrompt: v.initialPrompt, withNote: v.withNote };
  if (v.skipPermissions) p.skipPermissions = true;
  if (v.statusBar) p.statusBar = true;
  if (v.background) p.background = true;
  if (v.icon) p.icon = v.icon;
  return p;
}
