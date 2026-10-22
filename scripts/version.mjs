// Sets a new version in manifest.json, package.json and versions.json.
//   node scripts/version.mjs 1.0.1
import fs from "fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) {
  console.error("Usage: node scripts/version.mjs x.y.z");
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");
manifest.version = v;
pkg.version = v;
versions[v] = manifest.minAppVersion;
write("manifest.json", manifest);
write("package.json", pkg);
write("versions.json", versions);
console.log(`Version ${v} (minAppVersion ${manifest.minAppVersion})`);
