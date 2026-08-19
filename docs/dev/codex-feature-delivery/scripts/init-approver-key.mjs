#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { validateApprovalTrustRoot } from "./approval-attestation.mjs";
import { loadProjectContext } from "./project-context.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(scriptDir, "..");

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function usage(code = 2) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: init-approver-key.mjs --actor ACTOR --key-id ID --private-key PATH
  --role ROLE [--role ROLE ...]
  --gate GATE [--gate GATE ...]
  --profile PROFILE [--profile PROFILE ...]
  --target TARGET [--target TARGET ...]
  --valid-until ISO_TIME [--trust-root PATH] [--project-config PATH]
`);
  process.exit(code);
}

function rejectGitWorktreePath(path, label) {
  let parent;
  try { parent = realpathSync(dirname(path)); }
  catch (error) { fail(`${label} 的父目录必须预先存在且可解析：${error.message}`, 2); }
  const probe = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const root = realpathSync(probe.stdout.trim());
  const rel = relative(root, resolve(parent, basename(path)));
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    fail(`${label} 必须位于任何 Git worktree 之外：${path}`, 2);
  }
}

const args = process.argv.slice(2);
const options = {
  actor: null,
  keyId: null,
  privateKey: null,
    trustRoot: null,
    projectConfig: null,
  roles: [],
  gates: [],
  profiles: [],
  targets: [],
  validUntil: null,
};
for (let index = 0; index < args.length; index += 1) {
  const take = () => {
    const value = args[++index];
    if (!value) usage();
    return value;
  };
  const arg = args[index];
  if (arg === "-h" || arg === "--help") usage(0);
  else if (arg === "--actor") options.actor = take();
  else if (arg === "--key-id") options.keyId = take();
  else if (arg === "--private-key") options.privateKey = resolve(take());
  else if (arg === "--trust-root") options.trustRoot = resolve(take());
  else if (arg === "--project-config") options.projectConfig = resolve(take());
  else if (arg === "--role") options.roles.push(take());
  else if (arg === "--gate") options.gates.push(take());
  else if (arg === "--profile") options.profiles.push(take());
  else if (arg === "--target") options.targets.push(take());
  else if (arg === "--valid-until") options.validUntil = take();
  else usage();
}
if (!options.actor || !options.keyId || !options.privateKey || !options.validUntil) usage();
if (!options.trustRoot) {
  try { options.trustRoot = loadProjectContext({ projectConfig: options.projectConfig, frameworkDir }).governance.trustRoot; }
  catch (error) { fail(error.message, 2); }
}
rejectGitWorktreePath(options.privateKey, "private key");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.keyId)) fail("key-id 只能使用字母、数字、点、下划线和连字符。", 2);
const scopedLists = [
  ["role", options.roles, null],
  ["gate", options.gates, new Set(["G0", "G1", "G2", "G2C", "G3", "G4", "G5", "G6"])],
  ["profile", options.profiles, new Set(["lite", "standard", "controlled"])],
  ["target", options.targets, new Set(["local_engineering", "staging", "production"])],
];
for (const [label, values, allowed] of scopedLists) {
  if (values.length === 0 || new Set(values).size !== values.length || values.some((value) => !value || (allowed && !allowed.has(value)))) {
    fail(`${label} 必须显式提供至少一个允许值，且非空、唯一、在闭合集内。`, 2);
  }
}
const validUntil = Date.parse(options.validUntil);
if (!Number.isFinite(validUntil) || validUntil <= Date.now()) fail("valid-until 必须是未来的 ISO 时间。", 2);
const lockPath = `${options.trustRoot}.lock`;
let lockDescriptor;
let lockIdentity;
function releaseLock() {
  if (lockDescriptor === undefined) return;
  try { closeSync(lockDescriptor); } catch { /* best effort */ }
  lockDescriptor = undefined;
  try {
    const current = lstatSync(lockPath);
    if (lockIdentity && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) unlinkSync(lockPath);
  } catch { /* a visible residue fails closed */ }
}
try {
  lockDescriptor = openSync(lockPath, "wx", 0o600);
  lockIdentity = fstatSync(lockDescriptor);
  writeFileSync(lockDescriptor, `${JSON.stringify({ operation: "init-approver-key", key_id: options.keyId, pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
} catch (error) {
  if (lockDescriptor !== undefined) releaseLock();
  if (error?.code === "EEXIST") fail(`trust root 正由另一个管理员更新：${lockPath}`);
  fail(`无法取得 trust root lock：${error.message}`);
}
process.once("exit", releaseLock);
let trust;
let trustOriginalSource;
try {
  const metadata = lstatSync(options.trustRoot);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("trust root 必须是普通文件且不能是符号链接。 ");
  if (metadata.nlink !== 1) fail("trust root 不得是 hardlink。 ");
  trustOriginalSource = readFileSync(options.trustRoot, "utf8");
  trust = YAML.parse(trustOriginalSource);
} catch (error) {
  fail(`无法读取 trust root：${error.message}`);
}
const trustErrors = validateApprovalTrustRoot(trust);
if (trustErrors.length > 0) fail(trustErrors.join("; "));
if (trust.keys.some((key) => key.id === options.keyId)) fail(`key-id 已存在：${options.keyId}`);
try {
  const existing = lstatSync(options.privateKey);
  if (existing) fail(`private key 目标已存在，不会覆盖：${options.privateKey}`);
} catch (error) {
  if (error?.code !== "ENOENT") fail(`无法检查 private key 目标：${error.message}`);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
let privateDescriptor;
try {
  privateDescriptor = openSync(options.privateKey, "wx", 0o600);
  writeFileSync(privateDescriptor, privatePem, "utf8");
  closeSync(privateDescriptor);
  privateDescriptor = undefined;
} catch (error) {
  if (privateDescriptor !== undefined) closeSync(privateDescriptor);
  fail(`无法排他创建 private key：${error.message}`);
}
trust.keys.push({
  id: options.keyId,
  actor: options.actor,
  roles: options.roles,
  gates: options.gates,
  profiles: options.profiles,
  targets: options.targets,
  public_key_pem: publicPem,
  status: "active",
  valid_from: new Date().toISOString(),
  valid_until: new Date(validUntil).toISOString(),
});
const updatedErrors = validateApprovalTrustRoot(trust);
if (updatedErrors.length > 0) fail(`生成后的 trust root 无效：${updatedErrors.join("; ")}`);
const trustTemp = `${options.trustRoot}.tmp-${process.pid}`;
try {
  const descriptor = openSync(trustTemp, "wx", 0o600);
  writeFileSync(descriptor, YAML.stringify(trust, { lineWidth: 0 }), "utf8");
  closeSync(descriptor);
  if (readFileSync(options.trustRoot, "utf8") !== trustOriginalSource) throw new Error("trust root 在更新期间已变化；拒绝覆盖");
  renameSync(trustTemp, options.trustRoot);
} catch (error) {
  try { unlinkSync(trustTemp); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") process.stderr.write(`WARNING: trust root 临时文件清理失败：${cleanupError.message}\n`); }
  fail(`private key 已安全创建，但 trust root 更新失败；请保留诊断并人工处理：${error.message}`);
}
process.stdout.write(`Registered approval key: ${options.keyId} actor=${options.actor}\n`);
process.stdout.write(`Scope: roles=${options.roles.join(",")} gates=${options.gates.join(",")} profiles=${options.profiles.join(",")} targets=${options.targets.join(",")} valid_until=${new Date(validUntil).toISOString()}\n`);
process.stdout.write(`Private key (do not commit): ${options.privateKey}\n`);
process.stdout.write(`Trust root: ${options.trustRoot}\n`);
