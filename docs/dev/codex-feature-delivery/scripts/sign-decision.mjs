#!/usr/bin/env node

import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import {
  approvalPayloadDigest,
  canonicalApprovalPayload,
  validateApprovalTrustRoot,
  verifyApprovalAttestation,
} from "./approval-attestation.mjs";
import { resolveGatePolicy } from "./policy-registry.mjs";
import { loadProjectContext } from "./project-context.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(scriptDir, "..");

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

const USAGE = `Usage: sign-decision.mjs PACKAGE_DIR DECISION_ID --key-id ID --private-key PATH
  [--trust-root PATH] [--project-config PATH]
`;

function usage(code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(USAGE);
  process.exit(code);
}

function readSafeFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} 必须是普通文件且不能是符号链接：${path}`);
  if (metadata.nlink !== 1) fail(`${label} 不得是 hardlink：${path}`);
  return readFileSync(path, "utf8");
}

function validatePrivateKeyFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(`private key 必须是非符号链接、非 hardlink 的普通文件：${path}`);
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0) fail("private key 必须仅 owner 可访问（建议 mode 0600）。");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) fail("private key owner 必须是当前审批进程用户。");
  const canonical = realpathSync(path);
  const probe = spawnSync("git", ["-C", dirname(canonical), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status === 0) {
    const root = realpathSync(probe.stdout.trim());
    const rel = relative(root, canonical);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) fail("private key 必须位于任何 Git worktree 之外。 ");
  }
}

let heldLock = null;
function releasePackageLock() {
  if (!heldLock) return;
  const { descriptor, path, dev, ino } = heldLock;
  heldLock = null;
  try { closeSync(descriptor); } catch { /* best effort */ }
  try {
    const current = lstatSync(path);
    if (current.dev === dev && current.ino === ino) unlinkSync(path);
  } catch { /* fail-closed residue is visible for manual recovery */ }
}

function acquirePackageLock(packageDir, decisionId) {
  const path = resolve(packageDir, ".cfd-materialize.lock");
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    const identity = fstatSync(descriptor);
    writeFileSync(descriptor, `${JSON.stringify({
      schema_version: 1,
      operation: "sign-decision",
      decision_id: decisionId,
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      token: randomUUID(),
    })}\n`, "utf8");
    heldLock = { descriptor, path, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
      try { unlinkSync(path); } catch { /* only our just-created path can reach this branch */ }
    }
    if (error?.code === "EEXIST") fail(`另一个 Package writer 正在运行：${path}`);
    fail(`无法取得 Package writer lock：${error.message}`);
  }
  process.once("exit", releasePackageLock);
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => {
    releasePackageLock();
    process.exit(exitCode);
  });
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
if (args.length < 2) fail(USAGE.trimEnd(), 2);
const requestedPackageDir = resolve(args.shift());
const decisionId = args.shift();
const options = { keyId: null, privateKey: null, trustRoot: null, projectConfig: null };
for (let index = 0; index < args.length; index += 1) {
  const take = () => {
    const value = args[++index];
    if (!value) fail(`${args[index - 1]} 缺少值`, 2);
    return value;
  };
  if (args[index] === "--key-id") options.keyId = take();
  else if (args[index] === "--private-key") options.privateKey = resolve(take());
  else if (args[index] === "--trust-root") options.trustRoot = resolve(take());
  else if (args[index] === "--project-config") options.projectConfig = resolve(take());
  else fail(`未知参数：${args[index]}`, 2);
}
if (!options.keyId || !options.privateKey) fail("--key-id 与 --private-key 必填。", 2);
validatePrivateKeyFile(options.privateKey);
const packageMetadata = lstatSync(requestedPackageDir);
if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink()) fail("Package 必须是非符号链接目录。 ");
const packageDir = realpathSync(requestedPackageDir);
let projectContext;
try { projectContext = loadProjectContext({ projectConfig: options.projectConfig, startPath: packageDir, frameworkDir }); }
catch (error) { fail(error.message, 2); }
options.trustRoot ??= projectContext.governance.trustRoot;
acquirePackageLock(packageDir, decisionId);
const manifestPath = resolve(packageDir, "feature.yaml");
const decisionsPath = resolve(packageDir, "decisions.yaml");
const manifestDocument = YAML.parseDocument(readSafeFile(manifestPath, "feature.yaml"), { uniqueKeys: true });
if (manifestDocument.errors.length > 0) fail(`feature.yaml 无效：${manifestDocument.errors.map((error) => error.message).join("; ")}`);
const manifest = manifestDocument.toJS();
if (manifest?.schema_version !== 2 || manifest?.kind !== "FeaturePackage" || typeof manifest.feature?.id !== "string") fail("只支持具有 feature.id 的 Feature Package v2。 ");
const decisionsOriginalSource = readSafeFile(decisionsPath, "decisions.yaml");
const decisionDocument = YAML.parseDocument(decisionsOriginalSource, { uniqueKeys: true });
if (decisionDocument.errors.length > 0) fail(`decisions.yaml 无效：${decisionDocument.errors.map((error) => error.message).join("; ")}`);
const ledger = decisionDocument.toJS();
if (ledger?.schema_version !== 2 || ledger?.kind !== "GateDecisionLedger" || ledger?.feature_id !== manifest.feature.id) fail("decisions.yaml identity 必须与 Feature Package v2 一致。 ");
const index = ledger.entries?.findIndex((entry) => entry.id === decisionId) ?? -1;
if (index < 0) fail(`找不到 decision：${decisionId}`);
const decision = ledger.entries[index];
if (decision.state !== "passed") fail("只有 passed decision 需要 approval attestation。 ");
if (decision.attestation !== null && decision.attestation !== undefined) fail("decision 已有 attestation，不会覆盖；应追加 superseding decision。 ");
let resolvedPolicy;
try {
  resolvedPolicy = resolveGatePolicy(manifest.policy, frameworkDir);
} catch (error) {
  fail(`无法解析 Feature Package 内容寻址策略：${error.message}`);
}
if (decision.subject?.policy_digest !== resolvedPolicy.digest) fail("Decision subject.policy_digest 未绑定 Feature Package 的内容寻址 gate policy。 ");
const trustRoot = YAML.parse(readSafeFile(options.trustRoot, "approval trust root"));
const trustErrors = validateApprovalTrustRoot(trustRoot);
if (trustErrors.length > 0) fail(trustErrors.join("; "));
const trustKey = trustRoot.keys.find((key) => key.id === options.keyId);
if (!trustKey) fail(`trust root 不含 key-id：${options.keyId}`);
if (trustKey.actor !== decision.actor?.id) fail(`key ${options.keyId} 不属于 decision actor ${decision.actor?.id ?? "UNKNOWN"}`);
let privateKey;
try {
  privateKey = createPrivateKey(readSafeFile(options.privateKey, "private key"));
  if (privateKey.asymmetricKeyType !== "ed25519") fail("private key 必须是 Ed25519。 ");
  const derived = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const trusted = createPublicKey(trustKey.public_key_pem).export({ type: "spki", format: "pem" });
  if (derived !== trusted) fail(`private key 与 trust root key ${options.keyId} 不匹配。`);
} catch (error) {
  fail(`无法加载 private key：${error.message}`);
}
const payload = canonicalApprovalPayload(manifest, decision);
const attestation = {
  scheme: "ed25519-v1",
  key_id: options.keyId,
  payload_digest: approvalPayloadDigest(manifest, decision),
  signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
};
const signedDecision = { ...decision, attestation };
const attestationCheck = verifyApprovalAttestation({ manifest, decision: signedDecision, trustRoot });
if (!attestationCheck.valid) fail(`生成的 attestation 不满足 trust scope：${attestationCheck.reasons.join("; ")}`);
decisionDocument.setIn(["entries", index, "attestation"], attestation);
const updated = decisionDocument.toString({ lineWidth: 0 });
const verification = YAML.parseDocument(updated, { uniqueKeys: true });
if (verification.errors.length > 0) fail(`签名后的 decisions.yaml 无效：${verification.errors.map((error) => error.message).join("; ")}`);
const temp = `${decisionsPath}.tmp-${process.pid}`;
let descriptor;
try {
  descriptor = openSync(temp, "wx", 0o600);
  writeFileSync(descriptor, updated, "utf8");
  closeSync(descriptor);
  descriptor = undefined;
  if (readFileSync(decisionsPath, "utf8") !== decisionsOriginalSource) throw new Error("decisions.yaml 在签名期间已变化；拒绝覆盖并请重新审查");
  renameSync(temp, decisionsPath);
} catch (error) {
  if (descriptor !== undefined) closeSync(descriptor);
  try { unlinkSync(temp); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") process.stderr.write(`WARNING: 签名临时文件清理失败：${cleanupError.message}\n`); }
  fail(`无法原子写入 attestation：${error.message}`);
}
process.stdout.write(`Signed decision: ${decisionId} key=${options.keyId} digest=${attestation.payload_digest}\n`);
