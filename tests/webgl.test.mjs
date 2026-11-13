import { test } from "node:test";
import assert from "node:assert/strict";
import { webglBroken } from "../src/render.js";

test("WebGL stays on below Chromium 150", () => {
  assert.equal(webglBroken("142.0.7444.59"), false);
  assert.equal(webglBroken("149.0.1.2"), false);
});

test("WebGL is skipped from Chromium 150 on", () => {
  assert.equal(webglBroken("150.0.7871.250"), true);
  assert.equal(webglBroken("151.0.0.0"), true);
});

test("unknown version keeps WebGL", () => {
  assert.equal(webglBroken(""), false);
  assert.equal(webglBroken(undefined), false);
});
