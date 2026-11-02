// "What's new": changelog sections between two versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { ROOT } from "./helpers.mjs";
import { changelogSince, compareVersions } from "../src/changelog.js";

test("version order", () => {
  assert.ok(compareVersions("1.5.10", "1.5.2") > 0);
  assert.ok(compareVersions("1.5.0", "1.4.9") > 0);
  assert.equal(compareVersions("1.5", "1.5.0"), 0);
});

test("sections after the last seen version up to the current one, newest first", () => {
  const md = "# Changelog\n\n## 1.5.2\n\n- c\n\n## 1.5.1\n\n- b\n\n## 1.5.0\n\n- a\n";
  assert.deepEqual(changelogSince(md, "1.5.0", "1.5.2"), [
    { version: "1.5.2", body: "- c" },
    { version: "1.5.1", body: "- b" },
  ]);
  assert.deepEqual(changelogSince(md, "1.5.2", "1.5.2"), []);
});

test("the real changelog has a section for the version in manifest.json", () => {
  const md = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
  const s = changelogSince(md, "0", v);
  assert.equal(s[0]?.version, v, "release without changelog section");
  assert.ok(s[0].body.length > 10);
});
