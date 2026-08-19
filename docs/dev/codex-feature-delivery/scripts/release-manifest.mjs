#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FRAMEWORK_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const MANIFEST_NAME = "RELEASE-MANIFEST.json";
const DOMAIN = "codex-feature-delivery-release-manifest-v1\0";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function posixPath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") fail(`发行文件越出根目录：${path}`);
  return value;
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

export function computeDistributionDigest(files) {
  const digest = createHash("sha256").update(DOMAIN);
  for (const file of [...files].sort(comparePath)) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(file.mode, "utf8");
    digest.update("\0");
    digest.update(String(file.size), "utf8");
    digest.update("\0");
    digest.update(file.sha256, "utf8");
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function collectFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && (entry.name === MANIFEST_NAME || entry.name === "node_modules")) continue;
    if (entry.name === ".DS_Store") fail(`发行包不得包含 .DS_Store：${resolve(directory, entry.name)}`);
    const path = resolve(directory, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) fail(`发行包不得包含 symlink：${path}`);
    if (metadata.isDirectory()) {
      collectFiles(root, path, files);
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) fail(`发行包只允许单链接普通文件：${path}`);
    const bytes = readFileSync(path);
    files.push({
      path: posixPath(root, path),
      mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return files;
}

export function buildReleaseManifest(root = FRAMEWORK_ROOT) {
  const packagePath = resolve(root, "package.json");
  const policyPath = resolve(root, "gate-policy.yaml");
  if (!existsSync(packagePath) || !existsSync(policyPath)) fail("发行包缺少 package.json 或 gate-policy.yaml");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") fail("package.json 缺少 name/version");
  const policyDigest = sha256(readFileSync(policyPath));
  const policyHex = policyDigest.slice("sha256:".length);
  const snapshot = `policies/${policyHex}.yaml`;
  const snapshotPath = resolve(root, snapshot);
  if (!existsSync(snapshotPath)) fail(`active policy 缺少内容寻址快照：${snapshot}`);
  if (!readFileSync(policyPath).equals(readFileSync(snapshotPath))) fail("active policy 与内容寻址快照字节不一致");
  const files = collectFiles(root).sort(comparePath);
  return {
    schema_version: 1,
    kind: "FeatureDeliveryReleaseManifest",
    distribution: { name: packageJson.name, version: packageJson.version },
    manifest_path: MANIFEST_NAME,
    manifest_excludes: [MANIFEST_NAME, "node_modules/**"],
    active_policy: { digest: policyDigest, snapshot },
    files,
    distribution_digest: computeDistributionDigest(files),
  };
}

export function serializedManifest(root = FRAMEWORK_ROOT) {
  return `${JSON.stringify(buildReleaseManifest(root), null, 2)}\n`;
}

function usage() {
  process.stdout.write("Usage: release-manifest.mjs --write|--check\n");
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["--write", "--check", "-h", "--help"].includes(argv[0])) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    usage();
    return;
  }
  const manifestPath = resolve(FRAMEWORK_ROOT, MANIFEST_NAME);
  const expected = serializedManifest(FRAMEWORK_ROOT);
  if (argv[0] === "--write") {
    writeFileSync(manifestPath, expected, { encoding: "utf8", mode: 0o644 });
    process.stdout.write(`${buildReleaseManifest(FRAMEWORK_ROOT).distribution_digest}\n`);
    return;
  }
  if (!existsSync(manifestPath)) fail(`发行 manifest 不存在：${manifestPath}`);
  const actual = readFileSync(manifestPath, "utf8");
  if (actual !== expected) fail("RELEASE-MANIFEST.json 与当前发行 payload 不一致；必须重新生成并独立复核");
  const parsed = JSON.parse(actual);
  process.stdout.write(`${parsed.distribution.name}@${parsed.distribution.version} ${parsed.distribution_digest}\n`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-manifest: ${error.message}\n`);
    process.exitCode = 1;
  }
}
