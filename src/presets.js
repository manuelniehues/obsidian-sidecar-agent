// Sidecar Agent – standard tasks
/** Menu title of a standard task: its name, otherwise the start of its first message. */
export function presetLabel(p) {
  const text = (p.name || "").trim() || String(p.initialPrompt || "").trim().split("\n")[0];
  return text.length > 50 ? `${text.slice(0, 50)}…` : text;
}
