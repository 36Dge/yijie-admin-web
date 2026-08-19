#!/usr/bin/env node

import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { buildDeliverySummaryBody } from "./evaluate-feature-package.mjs";
import { loadProjectContext } from "./project-context.mjs";
import { resolveGatePolicy } from "./policy-registry.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(scriptDir, "..");
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireSafeFile(root, path, label) {
  if (!inside(root, path)) fail(`${label} 路径越出 Feature Package。`);
  const metadata = lstatIfPresent(path);
  if (!metadata) fail(`找不到 ${label}：${path}`);
  if (metadata.isSymbolicLink()) fail(`${label} 不得是符号链接：${path}`);
  if (!metadata.isFile()) fail(`${label} 必须是普通文件：${path}`);
  if (metadata.nlink !== 1) fail(`${label} 必须是独占文件，不得是 hardlink：${path}`);
  const canonical = realpathSync(path);
  if (!inside(root, canonical)) fail(`${label} realpath 越出 Feature Package：${canonical}`);
  return canonical;
}

let heldLock = null;

function releasePackageLock() {
  if (!heldLock) return;
  const { descriptor, path, dev, ino } = heldLock;
  heldLock = null;
  try {
    closeSync(descriptor);
  } catch {
    // Best effort on process exit.
  }
  try {
    const metadata = lstatIfPresent(path);
    if (metadata && metadata.dev === dev && metadata.ino === ino) unlinkSync(path);
  } catch {
    // Never delete a replacement lock owned by another process.
  }
}

function acquirePackageLock(root) {
  const path = resolve(root, ".cfd-materialize.lock");
  let descriptor;
  let ownedIdentity = null;
  try {
    descriptor = openSync(path, "wx", 0o600);
    const metadata = fstatSync(descriptor);
    ownedIdentity = { dev: metadata.dev, ino: metadata.ino };
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token: randomUUID() })}\n`, "utf8");
    heldLock = { descriptor, path, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
      try {
        const metadata = lstatIfPresent(path);
        if (metadata && ownedIdentity && metadata.dev === ownedIdentity.dev && metadata.ino === ownedIdentity.ino) unlinkSync(path);
      } catch { /* best effort */ }
    }
    if (error?.code === "EEXIST") fail(`另一个 materializer 正在操作该 Package：${path}`);
    fail(`无法获取 Package materialize lock：${error.message}`);
  }
  process.once("exit", releasePackageLock);
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      releasePackageLock();
      process.exit(exitCode);
    });
  }
}

function requireSafeParent(root, path) {
  const parent = dirname(path);
  if (!inside(root, parent)) fail("Delivery Summary 父目录越出 Feature Package。 ");
  const rel = relative(root, parent);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const metadata = lstatIfPresent(cursor);
    if (!metadata) fail(`Delivery Summary 父目录不存在：${cursor}`);
    if (metadata.isSymbolicLink()) fail(`Delivery Summary 路径不得经过符号链接：${cursor}`);
    if (!metadata.isDirectory()) fail(`Delivery Summary 父路径不是目录：${cursor}`);
  }
  const canonical = realpathSync(parent);
  if (!inside(root, canonical)) fail(`Delivery Summary 父目录 realpath 越出 Feature Package：${canonical}`);
  return canonical;
}

function atomicCreate(path, content) {
  const tempPath = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  let descriptor;
  try {
    descriptor = openSync(tempPath, "wx", 0o644);
    writeFileSync(descriptor, content, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    // link(2) 对目标使用排他创建语义；即使并发出现目标也不会覆盖。
    linkSync(tempPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (lstatIfPresent(tempPath)) unlinkSync(tempPath);
  }
}

function parseYaml(path, label) {
  const document = YAML.parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) fail(`${label} YAML 无效：${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

const cliArgs = process.argv.slice(2);
const argument = cliArgs.shift();
let projectConfig = null;
if (cliArgs[0] === "--project-config" && cliArgs[1] && cliArgs.length === 2) projectConfig = resolve(cliArgs[1]);
else if (cliArgs.length !== 0) {
  process.stderr.write("Usage: node materialize-delivery-summary.mjs PACKAGE_DIR [--project-config FILE]\n");
  process.exit(2);
}
if (!argument) fail("缺少 PACKAGE_DIR", 2);

const requestedPackageDir = resolve(argument);
const requestedMetadata = lstatIfPresent(requestedPackageDir);
if (!requestedMetadata || !requestedMetadata.isDirectory()) fail(`Package 目录不存在：${requestedPackageDir}`);
if (requestedMetadata.isSymbolicLink()) fail(`Package 目录不得是符号链接：${requestedPackageDir}`);
const packageDir = realpathSync(requestedPackageDir);
let projectContext;
try { projectContext = loadProjectContext({ projectConfig, startPath: packageDir, frameworkDir }); }
catch (error) { fail(error.message, 2); }
acquirePackageLock(packageDir);

const manifestPath = requireSafeFile(packageDir, resolve(packageDir, "feature.yaml"), "feature.yaml");
const manifest = parseYaml(manifestPath, "feature.yaml");
if (manifest?.schema_version !== 2 || manifest?.kind !== "FeaturePackage") fail("只支持 Feature Package v2。 ");
if (typeof manifest.feature?.id !== "string" || manifest.feature.id.length === 0) fail("feature.id 缺失。 ");

let policy;
try {
  policy = resolveGatePolicy(manifest.policy, frameworkDir).data;
} catch (error) {
  fail(`无法解析 Feature Package 内容寻址策略：${error.message}`);
}
const deliveryTarget = manifest.feature?.delivery_target;
const targetPolicy = policy.delivery_targets?.[deliveryTarget];
const terminalGate = targetPolicy?.terminal_gate;
if (typeof terminalGate !== "string" || !policy.gates?.[terminalGate]) fail(`gate-policy 未定义 target=${deliveryTarget} 的有效 terminal_gate。`);

const evaluation = spawnSync(
  process.execPath,
  [resolve(scriptDir, "evaluate-feature-package.mjs"), "--project-config", projectContext.configPath, "--repository-root", projectContext.repositoryRoot, "--gate", terminalGate, "--json", packageDir],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (evaluation.error) fail(`无法运行 evaluator：${evaluation.error.message}`);
if (evaluation.status !== 0) {
  process.stderr.write(evaluation.stdout ?? "");
  process.stderr.write(evaluation.stderr ?? "");
  fail(`${terminalGate} 尚未基于当前 subject 通过，不能生成 Delivery Summary。`);
}

let report;
try {
  report = JSON.parse(evaluation.stdout);
} catch (error) {
  fail(`evaluator 未返回有效 JSON：${error.message}`);
}
const terminalReport = report.gates?.find((entry) => entry.gate === terminalGate && entry.instance === "feature") ?? report.gates?.[0];
if (terminalReport?.state !== "passed") fail(`${terminalGate} 未通过。`);
if (typeof terminalReport.decision_id !== "string" || terminalReport.decision_id.length === 0) fail(`${terminalGate} 缺少 terminal decision ID。`);
if (!DIGEST_RE.test(String(terminalReport.decision_record_digest ?? ""))) fail(`${terminalGate} 缺少 terminal Decision record digest。`);

const policyDigestNames = Array.isArray(policy.gates?.[terminalGate]?.subject_digests)
  ? [...policy.gates[terminalGate].subject_digests].reverse()
  : [];
const digestFallbackNames = terminalGate === "G4"
  ? ["engineering_digest", "build_digest", "spec_digest"]
  : terminalGate === "G6"
    ? ["outcome_digest", "release_digest", "engineering_digest", "spec_digest"]
    : ["spec_digest", "declaration_digest"];
const reportedSubjectDigest = typeof terminalReport.subject_digest === "string" && DIGEST_RE.test(terminalReport.subject_digest)
  ? terminalReport.subject_digest
  : null;
const terminalSubjectDigest = reportedSubjectDigest
  ?? [...policyDigestNames, ...digestFallbackNames]
    .map((name) => report.digests?.[name])
    .find((value) => typeof value === "string" && DIGEST_RE.test(value));
if (!DIGEST_RE.test(String(terminalSubjectDigest ?? ""))) fail(`${terminalGate} 报告缺少可验证的 terminal subject digest。`);

const artifact = manifest.artifacts?.find((item) => item.kind === "delivery_summary");
if (!artifact || artifact.applicability !== "conditional") fail("manifest 必须声明 conditional delivery_summary artifact。 ");
if (typeof artifact.path !== "string" || artifact.path.length === 0) fail("delivery_summary artifact.path 无效。 ");
const targetPath = resolve(packageDir, artifact.path);
if (!inside(packageDir, targetPath)) fail("Delivery Summary 路径越出 Feature Package。 ");
if (lstatIfPresent(targetPath)) fail(`目标已存在，不会覆盖：${targetPath}`);
requireSafeParent(packageDir, targetPath);

const generatedAt = new Date().toISOString();
const deliveryClaim = deliveryTarget === "local_engineering"
  ? "engineering_complete_not_released"
  : "target_outcome_verified";
const frontmatter = {
  schema_version: 2,
  kind: "DeliverySummary",
  feature_id: manifest.feature?.id,
  delivery_target: deliveryTarget,
  terminal_gate: terminalGate,
  terminal_decision_id: terminalReport.decision_id,
  terminal_decision_digest: terminalReport.decision_record_digest,
  terminal_subject_digest: terminalSubjectDigest,
  delivery_claim: deliveryClaim,
  generated_at: generatedAt,
};
let body;
try {
  body = buildDeliverySummaryBody({
    manifest,
    terminalGate,
    terminalDecisionId: terminalReport.decision_id,
    terminalDecisionDigest: terminalReport.decision_record_digest,
    terminalSubjectDigest,
    deliveryClaim,
    generatedAt,
  });
} catch (error) {
  fail(error.message);
}
frontmatter.summary_body_digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const output = `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body}`;
try {
  atomicCreate(targetPath, output);
} catch (error) {
  fail(`Delivery Summary materialize 失败且未覆盖目标：${error.message}`);
}

process.stdout.write(`Created: ${targetPath}\n`);
process.stdout.write(`terminal=${terminalGate} decision=${terminalReport.decision_id} claim=${deliveryClaim}\n`);
process.stdout.write("Summary 已由当前 manifest/terminal subject 派生；请勿手工改写，继续运行 check-feature-package.sh --strict。\n");
