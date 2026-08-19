#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { loadProjectContext } from "./project-context.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(scriptDir, "..");

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
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
  return { canonical, metadata };
}

function replaceTokens(source, replacements) {
  let result = source;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, () => String(value));
  }
  return result;
}

function inlineCodeList(values) {
  if (!Array.isArray(values) || values.length === 0) return "（无）";
  return values.map((value) => `\`${String(value).replaceAll("`", "\\`")}\``).join(", ");
}

function writeExclusiveTemp(directory, label, content, mode = 0o644) {
  const path = resolve(directory, `.${label}.tmp-${process.pid}-${randomUUID()}`);
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return path;
}

const cliArgs = process.argv.slice(2);
const packageArgument = cliArgs.shift();
const boundaryId = cliArgs.shift();
let projectConfig = null;
if (cliArgs[0] === "--project-config" && cliArgs[1] && cliArgs.length === 2) projectConfig = resolve(cliArgs[1]);
else if (cliArgs.length !== 0 || !packageArgument || !boundaryId) {
  process.stderr.write("Usage: node materialize-boundary.mjs PACKAGE_DIR BND-ID [--project-config FILE]\n");
  process.exit(2);
}
const requestedPackageDir = resolve(packageArgument);
if (!/^BND-[0-9]{3,}$/.test(boundaryId)) fail("BND-ID 必须符合 BND-NNN。", 2);

const packageMetadata = lstatIfPresent(requestedPackageDir);
if (!packageMetadata || !packageMetadata.isDirectory()) fail(`Package 目录不存在：${requestedPackageDir}`);
if (packageMetadata.isSymbolicLink()) fail(`Package 目录不得是符号链接：${requestedPackageDir}`);
const packageDir = realpathSync(requestedPackageDir);
try { loadProjectContext({ projectConfig, startPath: packageDir, frameworkDir }); }
catch (error) { fail(error.message, 2); }
const materializeLockPath = resolve(packageDir, ".cfd-materialize.lock");
let materializeLockDescriptor;
let materializeLockIdentity;
function releaseMaterializeLock() {
  if (materializeLockDescriptor === undefined) return;
  try {
    closeSync(materializeLockDescriptor);
  } catch {
    // Best effort on process exit; identity check below prevents deleting another process' lock.
  }
  materializeLockDescriptor = undefined;
  try {
    const current = lstatIfPresent(materializeLockPath);
    if (current && materializeLockIdentity
      && current.dev === materializeLockIdentity.dev
      && current.ino === materializeLockIdentity.ino) {
      unlinkSync(materializeLockPath);
    }
  } catch {
    // A failed cleanup leaves a visible fail-closed lock for manual recovery.
  }
}
try {
  materializeLockDescriptor = openSync(materializeLockPath, "wx", 0o600);
  materializeLockIdentity = fstatSync(materializeLockDescriptor);
  writeFileSync(materializeLockDescriptor, `${JSON.stringify({
    schema_version: 1,
    operation: "materialize-boundary",
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    boundary_id: boundaryId,
  })}\n`, "utf8");
} catch (error) {
  if (error?.code === "EEXIST") {
    fail(`Package 正在执行 materialize；锁已存在：${materializeLockPath}`);
  }
  if (materializeLockDescriptor !== undefined) releaseMaterializeLock();
  fail(`无法取得 Package materialize 锁：${error.message}`);
}
process.once("exit", releaseMaterializeLock);
for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => process.exit(code));
}
const manifestPath = resolve(packageDir, "feature.yaml");
const { metadata: manifestMetadata } = requireSafeFile(packageDir, manifestPath, "feature.yaml");
const manifestOriginalSource = readFileSync(manifestPath, "utf8");
const document = YAML.parseDocument(manifestOriginalSource, { uniqueKeys: true });
if (document.errors.length > 0) fail(`feature.yaml YAML 无效：${document.errors.map((error) => error.message).join("; ")}`);
const manifest = document.toJS();
if (manifest?.schema_version !== 2 || manifest?.kind !== "FeaturePackage") fail("只支持 Feature Package v2。 ");

const boundaryIndex = Array.isArray(manifest.boundaries)
  ? manifest.boundaries.findIndex((boundary) => boundary?.id === boundaryId)
  : -1;
if (boundaryIndex < 0) fail(`manifest 尚未声明 Boundary ${boundaryId}。`);
const boundary = manifest.boundaries[boundaryIndex];
const artifactId = `ART-BOUNDARY-${boundaryId}`;
const artifactPath = `boundaries/${boundaryId}.md`;
if (boundary.artifact_id !== artifactId) fail(`${boundaryId}.artifact_id 必须先声明为约定 forward ref ${artifactId}。`);
const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
const contractIndex = artifacts.find((artifact) => artifact?.kind === "contract_change_plan");
if (!contractIndex || contractIndex.path !== "04-contract-change-plan.md" || contractIndex.authority !== "index") {
  fail("manifest 缺少固定的 contract_change_plan index 声明。 ");
}
const existingReferencedArtifact = artifacts.find((artifact) => artifact?.id === boundary.artifact_id);
if (existingReferencedArtifact) fail(`${boundaryId}.artifact_id 已指向 Artifact ${existingReferencedArtifact.id}，不会覆盖或重复 materialize。`);
if (artifacts.some((artifact) => artifact?.id === artifactId)) fail(`Artifact ID 已存在：${artifactId}`);
if (artifacts.some((artifact) => artifact?.path === artifactPath)) fail(`Artifact path 已存在：${artifactPath}`);

const boundariesDir = resolve(packageDir, "boundaries");
if (!inside(packageDir, boundariesDir)) fail("boundaries 目录越出 Feature Package。 ");
const boundariesMetadata = lstatIfPresent(boundariesDir);
if (!boundariesMetadata) mkdirSync(boundariesDir, { mode: 0o755 });
const currentBoundariesMetadata = lstatIfPresent(boundariesDir);
if (currentBoundariesMetadata?.isSymbolicLink()) fail(`boundaries 目录不得是符号链接：${boundariesDir}`);
if (!currentBoundariesMetadata?.isDirectory()) fail(`boundaries 必须是目录：${boundariesDir}`);
if (!inside(packageDir, realpathSync(boundariesDir))) fail("boundaries realpath 越出 Feature Package。 ");

const targetPath = resolve(boundariesDir, `${boundaryId}.md`);
if (!inside(packageDir, targetPath)) fail("Boundary Artifact 路径越出 Feature Package。 ");
if (lstatIfPresent(targetPath)) fail(`目标已存在，不会覆盖：${targetPath}`);
const templatePath = resolve(frameworkDir, "templates/feature-package/boundary-spec.md");
const templateMetadata = lstatIfPresent(templatePath);
if (!templateMetadata?.isFile() || templateMetadata.isSymbolicLink()) fail(`找不到安全的 Boundary 模板：${templatePath}`);

const today = new Date().toISOString().slice(0, 10);
const boundarySource = replaceTokens(readFileSync(templatePath, "utf8"), {
  FEATURE_ID: manifest.feature?.id,
  FEATURE_TITLE: manifest.feature?.title,
  BOUNDARY_ID: boundaryId,
  BOUNDARY_TYPE: boundary.type,
  BOUNDARY_IMPACT: boundary.impact,
  BOUNDARY_AUTHORITY: boundary.authority,
  BOUNDARY_PRODUCERS: inlineCodeList(boundary.producers),
  BOUNDARY_CONSUMERS: inlineCodeList(boundary.consumers),
  BOUNDARY_KNOWN_UNKNOWNS: inlineCodeList(boundary.known_unknowns),
  DATE: today,
  BOUNDARY_IDENTITY: `${boundaryId} / ${boundary.type} / ${boundary.impact}`,
  BOUNDARY_OWNER: boundary.owner,
  AUTHORITATIVE_SOURCE: boundary.authority,
  PRODUCERS: inlineCodeList(boundary.producers),
  SUPPORTED_CONSUMERS: inlineCodeList(boundary.consumers),
});

document.setIn(["boundaries", boundaryIndex, "artifact_id"], artifactId);
document.addIn(["artifacts"], {
  id: artifactId,
  kind: "boundary_spec",
  path: artifactPath,
  authority: "normative",
  applicability: "required",
  reason: `boundary_${boundaryId}`,
});
document.setIn(["feature", "updated_at"], today);
const contractIndexPosition = artifacts.findIndex((artifact) => artifact?.id === contractIndex.id);
document.setIn(["artifacts", contractIndexPosition, "applicability"], "required");
document.setIn(["artifacts", contractIndexPosition, "reason"], "boundaries_present");
const manifestSource = document.toString({ lineWidth: 0 });
const verification = YAML.parseDocument(manifestSource, { uniqueKeys: true });
if (verification.errors.length > 0) fail(`更新后的 feature.yaml 无效：${verification.errors.map((error) => error.message).join("; ")}`);

const contractIndexPath = resolve(packageDir, contractIndex.path);
if (!inside(packageDir, contractIndexPath)) fail("Boundary index 路径越出 Feature Package。 ");
const currentIndex = lstatIfPresent(contractIndexPath);
if (currentIndex && (currentIndex.isSymbolicLink() || !currentIndex.isFile() || !inside(packageDir, realpathSync(contractIndexPath)))) fail("现有 Boundary index 不是包内普通文件。 ");
const previousIndexSource = currentIndex ? readFileSync(contractIndexPath, "utf8") : null;
const previousIndexMode = currentIndex?.mode ?? 0o644;
const contractTemplatePath = resolve(frameworkDir, "templates/feature-package/04-contract-change-plan.md");
const contractTemplate = lstatIfPresent(contractTemplatePath);
if (!contractTemplate?.isFile() || contractTemplate.isSymbolicLink()) fail(`找不到安全的 Boundary index 模板：${contractTemplatePath}`);
const indexRows = manifest.boundaries.map((item) => {
  const expectedId = `ART-BOUNDARY-${item.id}`;
  const expectedPath = `boundaries/${item.id}.md`;
  return `| \`${item.id}\` | \`${item.type}\` / \`${item.impact}\` | \`${expectedId}\` | \`${expectedPath}\` | ${inlineCodeList(item.producers)} / ${inlineCodeList(item.consumers)} | ${String(item.owner).replaceAll("|", "\\|")} |`;
}).join("\n");
const contractIndexSource = replaceTokens(readFileSync(contractTemplatePath, "utf8"), {
  FEATURE_ID: manifest.feature?.id,
  BOUNDARY_INDEX_ROWS: indexRows,
});

let boundaryTemp;
let contractIndexTemp;
let manifestTemp;
let boundaryPublished = false;
let contractIndexPublished = false;
let operationError;
try {
  boundaryTemp = writeExclusiveTemp(boundariesDir, basename(targetPath), boundarySource);
  contractIndexTemp = writeExclusiveTemp(packageDir, basename(contractIndexPath), contractIndexSource, previousIndexMode & 0o777);
  manifestTemp = writeExclusiveTemp(packageDir, "feature.yaml", manifestSource, manifestMetadata.mode & 0o777);
  chmodSync(manifestTemp, manifestMetadata.mode & 0o777);

  // Package lock 协调本体系的 writer；CAS 再防止不遵守锁的人工/外部 writer
  // 在 read-modify-publish 窗口内覆盖 manifest 或 Boundary index。
  if (readFileSync(manifestPath, "utf8") !== manifestOriginalSource) {
    throw new Error("feature.yaml 在 materialize 期间已变化；拒绝发布陈旧更新");
  }
  const observedIndex = lstatIfPresent(contractIndexPath);
  if ((previousIndexSource === null && observedIndex)
    || (previousIndexSource !== null && (!observedIndex || readFileSync(contractIndexPath, "utf8") !== previousIndexSource))) {
    throw new Error("Boundary index 在 materialize 期间已变化；拒绝发布陈旧更新");
  }

  // 先用 link(2) 排他发布新文件，再原子替换 manifest；第二步失败时回滚新文件。
  linkSync(boundaryTemp, targetPath);
  boundaryPublished = true;
  renameSync(contractIndexTemp, contractIndexPath);
  contractIndexTemp = undefined;
  contractIndexPublished = true;
  renameSync(manifestTemp, manifestPath);
  manifestTemp = undefined;
} catch (error) {
  if (boundaryPublished && lstatIfPresent(targetPath)) unlinkSync(targetPath);
  if (contractIndexPublished) {
    try {
      if (previousIndexSource === null) {
        if (lstatIfPresent(contractIndexPath)) unlinkSync(contractIndexPath);
      } else {
        const restoreTemp = writeExclusiveTemp(packageDir, basename(contractIndexPath), previousIndexSource, previousIndexMode & 0o777);
        renameSync(restoreTemp, contractIndexPath);
      }
    } catch (restoreError) {
      operationError = new Error(`${error.message}; Boundary index 回滚失败：${restoreError.message}`);
    }
  }
  operationError ??= error;
} finally {
  if (boundaryTemp && lstatIfPresent(boundaryTemp)) unlinkSync(boundaryTemp);
  if (contractIndexTemp && lstatIfPresent(contractIndexTemp)) unlinkSync(contractIndexTemp);
  if (manifestTemp && lstatIfPresent(manifestTemp)) unlinkSync(manifestTemp);
}
if (operationError) fail(`Boundary materialize 失败，已回滚：${operationError.message}`);

process.stdout.write(`Created: ${targetPath}\n`);
process.stdout.write(`Updated: ${manifestPath}\n`);
process.stdout.write(`boundary=${boundaryId} artifact=${artifactId}\n`);
