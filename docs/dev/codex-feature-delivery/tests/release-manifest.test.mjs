import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildReleaseManifest,
  computeDistributionDigest,
  serializedManifest,
} from "../scripts/release-manifest.mjs";

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release manifest is canonical and binds every distribution payload file", () => {
  const actual = readFileSync(resolve(frameworkRoot, "RELEASE-MANIFEST.json"), "utf8");
  assert.equal(actual, serializedManifest(frameworkRoot));
  const manifest = buildReleaseManifest(frameworkRoot);
  assert.equal(manifest.distribution.version, "2.0.0");
  assert.match(manifest.distribution_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(manifest.files.some((file) => file.path === "scripts/evaluate-feature-package.mjs"));
  assert.ok(manifest.files.some((file) => file.path === "schemas/feature-package.schema.json"));
  assert.ok(!manifest.files.some((file) => file.path === "RELEASE-MANIFEST.json"));
});

test("distribution digest changes when any bound file fact changes", () => {
  const files = buildReleaseManifest(frameworkRoot).files;
  const changed = files.map((file, index) => index === 0 ? { ...file, size: file.size + 1 } : file);
  assert.notEqual(computeDistributionDigest(files), computeDistributionDigest(changed));
});
