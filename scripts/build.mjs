// Builds main.js and styles.css into dist/ (the three release files: main.js, manifest.json, styles.css).
//   npm run build            build only
//   npm run build -- --install <vault>   also copy into <vault>/.obsidian/plugins/sidecar-agent/
import { build } from "esbuild";
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main.js")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron"],
  loader: { ".py": "text" },
  legalComments: "none",
  logLevel: "warning",
  outfile: path.join(dist, "main.js"),
});

// Scope xterm.css to the plugin container so it does not clash with other terminal plugins.
const xterm = fs.readFileSync(path.join(root, "node_modules/@xterm/xterm/css/xterm.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const scoped = xterm.replace(/(^|\})\s*([^{}@]+)\{/g, (m, b, sel) => b + "\n" + sel.split(",").map((s) => ".sidecar-agent-panel " + s.trim()).join(", ") + " {");
const css = "/* xterm.js (MIT, Copyright (c) The xterm.js authors), scoped to .sidecar-agent-panel */\n" + scoped + "\n\n" + fs.readFileSync(path.join(root, "styles.css"), "utf8");
fs.writeFileSync(path.join(dist, "styles.css"), css);
fs.copyFileSync(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
console.log(`Build ok: dist/main.js ${fs.statSync(path.join(dist, "main.js")).size} bytes`);

const i = process.argv.indexOf("--install");
if (i > 0 && process.argv[i + 1]) {
  const dest = path.join(process.argv[i + 1], ".obsidian", "plugins", "sidecar-agent");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["main.js", "styles.css", "manifest.json"]) fs.copyFileSync(path.join(dist, f), path.join(dest, f));
  console.log(`Installed to ${dest}`);
}
