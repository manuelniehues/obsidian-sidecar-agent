// Checks that every t("key") used in src/ exists in both translation tables, and that both tables have the same keys.
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = fs.readFileSync(path.join(root, "src/i18n.js"), "utf8");
const table = (name) => {
  const block = src.slice(src.indexOf(`const ${name} = {`), src.indexOf("};", src.indexOf(`const ${name} = {`)));
  return new Set([...block.matchAll(/^\s*"([\w.]+)":/gm)].map((m) => m[1]));
};
const en = table("EN");
const de = table("DE");
const used = new Set();
for (const f of fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js"))) {
  const code = fs.readFileSync(path.join(root, "src", f), "utf8");
  for (const m of code.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
  for (const m of code.matchAll(/\?\s*"([a-z]+\.[\w.]+)"\s*:\s*"([a-z]+\.[\w.]+)"/g)) used.add(m[1]).add(m[2]);
}
for (const id of ["all", "open", "claude", "agy"]) used.add(`filter.${id}`);
const problems = [];
for (const k of used) if (!en.has(k)) problems.push(`missing in EN: ${k}`);
for (const k of en) if (!de.has(k)) problems.push(`missing in DE: ${k}`);
for (const k of de) if (!en.has(k)) problems.push(`only in DE: ${k}`);
for (const k of en) if (!used.has(k)) problems.push(`unused: ${k}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n ok: ${en.size} keys, ${used.size} used`);
