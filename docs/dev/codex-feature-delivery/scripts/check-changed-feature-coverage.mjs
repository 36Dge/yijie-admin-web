#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { validateApprovalTrustRoot } from "./approval-attestation.mjs";
import { gatePolicyDigest, validateGatePolicySource } from "./policy-registry.mjs";
import { loadProjectContext, loadProjectContextFromSources } from "./project-context.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(MODULE_PATH);
const FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
const EVALUATOR = resolve(SCRIPT_DIR, "evaluate-feature-package.mjs");
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const GATE_ORDER = { G2: 2, G3: 3, G4: 4 };
let evaluatorEnvironment = { ...process.env };
let evaluatorRepositoryRoot = null;
const temporaryDirectories = new Set();
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(MODULE_PATH);
  } catch {
    return false;
  }
}
process.on("exit", () => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function usage(code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  check-changed-feature-coverage.mjs --base REF --head REF [options]
  check-changed-feature-coverage.mjs --file PATH [--file PATH ...] [options]

Options:
  --repo-root DIR             Git repository root; default: current directory.
  --project-config FILE       Project-root .feature-delivery.yaml; otherwise discovery/env is used.
  --repo-id ID                Assert the configured current repository ID; cannot override it.
  --feature-root DIR          Assert the configured Feature root; cannot override it.
  --policy FILE               Explicit policy path; default: configured project governance policy.
  --trust-root FILE           Explicit trust path; default: configured project governance trust root.
  --required-gate G2|G3|G4   Assert the configured policy Gate; cannot override it.
  --base REF --head REF       Target base and candidate head; diff uses merge-base...head.
  --file PATH                 Explicit repo-relative changed path; repeatable.
  --base-sha SHA              G2 base ref for explicit-file mode.
  --code-sha SHA              G3/G4 code ref for explicit-file mode.
  --allow-policy-bootstrap    Only when base has no policy, load it from head.
  --bootstrap-digest DIGEST   External repository/admin pin required for bootstrap-head exemption.
  --governance-digest DIGEST  External repository/admin pin for isolated trust/TCB governance.
  --json                      Emit a machine-readable report.
  -h, --help
`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(), projectConfig: null, repoId: null, featureRoot: null, policy: null, trustRoot: null,
    requiredGate: null, base: null, head: null, files: [], baseSha: null, codeSha: null,
    allowPolicyBootstrap: false,
    bootstrapDigest: process.env.CFD_BOOTSTRAP_APPROVAL_DIGEST || null,
    governanceDigest: process.env.CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST || null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} 缺少值`);
      return value;
    };
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--repo-root") options.repoRoot = take();
    else if (arg === "--project-config") options.projectConfig = take();
    else if (arg === "--repo-id") options.repoId = take();
    else if (arg === "--feature-root") options.featureRoot = take();
    else if (arg === "--policy") options.policy = take();
    else if (arg === "--trust-root") options.trustRoot = take();
    else if (arg === "--required-gate") options.requiredGate = take();
    else if (arg === "--base") options.base = take();
    else if (arg === "--head") options.head = take();
    else if (arg === "--file") options.files.push(take());
    else if (arg === "--base-sha") options.baseSha = take();
    else if (arg === "--code-sha") options.codeSha = take();
    else if (arg === "--allow-policy-bootstrap") options.allowPolicyBootstrap = true;
    else if (arg === "--bootstrap-digest") options.bootstrapDigest = take();
    else if (arg === "--governance-digest") options.governanceDigest = take();
    else if (arg === "--json") options.json = true;
    else throw new Error(`未知参数：${arg}`);
  }
  const gitMode = Boolean(options.base || options.head);
  if (gitMode && (!options.base || !options.head)) throw new Error("--base 与 --head 必须同时指定");
  if (gitMode && options.files.length > 0) throw new Error("git base/head 模式不能同时使用 --file");
  if (!gitMode && options.files.length === 0) throw new Error("必须指定 --base/--head 或至少一个 --file");
  if (options.requiredGate && !GATE_ORDER[options.requiredGate]) throw new Error(`--required-gate 不支持 ${options.requiredGate}`);
  if (options.baseSha && !SHA_RE.test(options.baseSha)) throw new Error("--base-sha 必须是完整 40 或 64 位小写 SHA");
  if (options.codeSha && !SHA_RE.test(options.codeSha)) throw new Error("--code-sha 必须是完整 40 或 64 位小写 SHA");
  if (options.bootstrapDigest && !DIGEST_RE.test(options.bootstrapDigest)) throw new Error("--bootstrap-digest/CFD_BOOTSTRAP_APPROVAL_DIGEST 必须是 sha256");
  if (options.governanceDigest && !DIGEST_RE.test(options.governanceDigest)) throw new Error("--governance-digest/CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST 必须是 sha256");
  return { ...options, gitMode };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function git(repoRoot, args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${String(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export function decodeGitPathOutput(buffer, label = "Git path output") {
  if (!Buffer.isBuffer(buffer)) throw new Error(`${label} 必须是 Buffer`);
  try {
    return FATAL_UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error(`${label} 含非 UTF-8 路径字节；为避免摘要/路径别名，拒绝处理`);
  }
}

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("changed path 必须是非空、无 NUL 的字符串");
  const slash = value.replaceAll("\\", "/").normalize("NFC");
  if (isAbsolute(slash) || slash === "." || slash.startsWith("../") || slash.includes("/../") || slash.endsWith("/..")) throw new Error(`changed path 必须是 repo-relative 且不能越界：${value}`);
  const normalized = slash.replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || normalized.endsWith("/")) throw new Error(`changed path 必须指向文件：${value}`);
  return normalized;
}

function parseYamlSource(source, label) {
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

function validatePolicy(policy, label) {
  const required = ["schema_version", "kind", "repository_id", "feature_root", "required_gate", "protected_paths", "exemptions"];
  for (const field of required) if (!Object.hasOwn(policy ?? {}, field)) throw new Error(`${label}: 缺少 ${field}`);
  const allowedPolicyFields = new Set(required);
  for (const field of Object.keys(policy ?? {})) if (!allowedPolicyFields.has(field)) throw new Error(`${label}: 不允许字段 ${field}`);
  if (policy.schema_version !== 1 || policy.kind !== "FeatureChangeCoveragePolicy") throw new Error(`${label}: policy identity 非法`);
  if (typeof policy.repository_id !== "string" || !policy.repository_id) throw new Error(`${label}: repository_id 非法`);
  if (typeof policy.feature_root !== "string" || !policy.feature_root) throw new Error(`${label}: feature_root 非法`);
  policy.feature_root = normalizePath(policy.feature_root);
  if (!GATE_ORDER[policy.required_gate]) throw new Error(`${label}: required_gate 必须是 G2/G3/G4`);
  if (!Array.isArray(policy.protected_paths)) throw new Error(`${label}: protected_paths 必须是数组`);
  const protectedPaths = new Set();
  for (const [index, rule] of policy.protected_paths.entries()) {
    const item = `${label}.protected_paths[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`${item} 必须是 object`);
    for (const field of Object.keys(rule)) if (!["path", "match", "mode"].includes(field)) throw new Error(`${item}: 不允许字段 ${field}`);
    if (typeof rule.path !== "string") throw new Error(`${item}.path 必须是字符串`);
    rule.path = normalizePath(rule.path);
    if (!["exact", "prefix"].includes(rule.match)) throw new Error(`${item}.match 必须是 exact|prefix`);
    const ruleIdentity = `${rule.match}\0${rule.path}`;
    if (protectedPaths.has(ruleIdentity)) throw new Error(`${item}.path/match 重复`);
    protectedPaths.add(ruleIdentity);
    if (!["exemption_only", "controlled_g4_or_exemption", "external_digest_only"].includes(rule.mode)) throw new Error(`${item}.mode 无效`);
  }
  if (!Array.isArray(policy.exemptions)) throw new Error(`${label}: exemptions 必须是数组`);
  const ids = new Set();
  for (const [index, exemption] of policy.exemptions.entries()) {
    const item = `${label}.exemptions[${index}]`;
    const exemptionFields = ["id", "owner", "rationale", "approval_reference", "created_at", "expires_at", "one_time", "changed_files", "head_content_digest"];
    for (const field of exemptionFields) {
      if (!Object.hasOwn(exemption ?? {}, field)) throw new Error(`${item}: 缺少 ${field}`);
    }
    for (const field of Object.keys(exemption ?? {})) if (!exemptionFields.includes(field)) throw new Error(`${item}: 不允许字段 ${field}`);
    for (const field of ["id", "owner", "rationale", "approval_reference", "created_at", "expires_at"]) if (typeof exemption[field] !== "string" || !exemption[field]) throw new Error(`${item}.${field} 必须是非空字符串`);
    if (ids.has(exemption.id)) throw new Error(`${item}: exemption ID 重复`);
    ids.add(exemption.id);
    if (exemption.one_time !== true) throw new Error(`${item}.one_time 必须为 true`);
    if (!Array.isArray(exemption.changed_files) || exemption.changed_files.length === 0) throw new Error(`${item}.changed_files 必须是非空数组`);
    const normalized = exemption.changed_files.map(normalizePath);
    if (new Set(normalized).size !== normalized.length) throw new Error(`${item}.changed_files 含重复项`);
    if (JSON.stringify([...normalized].sort()) !== JSON.stringify(normalized)) throw new Error(`${item}.changed_files 必须按字典序排序`);
    if (!DIGEST_RE.test(exemption.head_content_digest)) throw new Error(`${item}.head_content_digest 必须是 sha256`);
    const createdAt = Date.parse(exemption.created_at);
    const expiresAt = Date.parse(exemption.expires_at);
    const now = Date.now();
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`${item}: created_at/expires_at 必须是 ISO 时间`);
    if (createdAt > now) throw new Error(`${item}: created_at 不得位于未来`);
    if (expiresAt <= createdAt) throw new Error(`${item}: expires_at 必须晚于 created_at`);
  }
  return policy;
}

function protectedRuleForPath(policy, path) {
  const matches = policy.protected_paths.filter((rule) => rule.match === "exact"
    ? path === rule.path
    : path === rule.path || path.startsWith(`${rule.path}/`));
  matches.sort((left, right) => right.path.length - left.path.length
    || Number(right.match === "exact") - Number(left.match === "exact"));
  if (matches.length > 1 && matches[0].path.length === matches[1].path.length && matches[0].match === matches[1].match) {
    throw new Error(`protected_paths 对 ${path} 存在同等最具体规则`);
  }
  return matches[0] ?? null;
}

function repoRelativePath(repoRoot, candidatePath) {
  const rel = relative(repoRoot, candidatePath).split(sep).join("/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : normalizePath(rel);
}

function requestedPath(repoRoot, value) {
  return isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
}

function gitTreeEntry(repoRoot, commitSha, path) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-tree", "-z", commitSha, "--", path], { encoding: null, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-tree ${commitSha}:${path} 失败：${String(result.stderr || result.stdout).trim()}`);
  if (result.stdout.length === 0) return null;
  const records = decodeGitPathOutput(result.stdout, `git ls-tree ${commitSha}:${path}`).split("\0").filter(Boolean);
  const exact = records.filter((record) => record.slice(record.indexOf("\t") + 1) === path);
  if (exact.length !== 1) throw new Error(`${commitSha}:${path} 必须唯一解析为一个 Git entry`);
  const tab = exact[0].indexOf("\t");
  const metadata = exact[0].slice(0, tab);
  const resolvedPath = exact[0].slice(tab + 1);
  const [mode, type, object] = metadata.split(" ");
  return { mode, type, object, path: resolvedPath };
}

function gitRegularBlob(repoRoot, commitSha, path, { allowMissing = false } = {}) {
  const entry = gitTreeEntry(repoRoot, commitSha, path);
  if (!entry) {
    if (allowMissing) return null;
    throw new Error(`${commitSha}:${path} 不存在`);
  }
  if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
    throw new Error(`${commitSha}:${path} 必须是普通 Git blob（拒绝 mode=${entry.mode} type=${entry.type} 的 symlink/tree/submodule）`);
  }
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", entry.object], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git cat-file ${entry.object} 失败：${String(result.stderr || result.stdout).trim()}`);
  return { content: result.stdout, mode: entry.mode, object: entry.object };
}

function readRegularWorktreeFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} 必须是普通文件（拒绝 symlink/tree）：${path}`);
  return readFileSync(path);
}

function loadPolicy(options, repoRoot, policyPath, targetBaseSha, headSha) {
  const relativePolicy = repoRelativePath(repoRoot, policyPath);
  if (options.gitMode && relativePolicy) {
    const fromBase = gitRegularBlob(repoRoot, targetBaseSha, relativePolicy, { allowMissing: true });
    if (fromBase) return { policy: validatePolicy(parseYamlSource(fromBase.content.toString("utf8"), `${targetBaseSha}:${relativePolicy}`), relativePolicy), source: "target_base", relativePolicy };
    if (!options.allowPolicyBootstrap) throw new Error(`target base ${targetBaseSha} 不含 ${relativePolicy}；首次接入必须显式 --allow-policy-bootstrap`);
    const fromHead = gitRegularBlob(repoRoot, headSha, relativePolicy, { allowMissing: true });
    if (!fromHead) throw new Error(`bootstrap head ${headSha} 也不含 ${relativePolicy}`);
    return { policy: validatePolicy(parseYamlSource(fromHead.content.toString("utf8"), `${headSha}:${relativePolicy}`), relativePolicy), source: "bootstrap_head", relativePolicy };
  }
  const source = readRegularWorktreeFile(policyPath, "coverage policy").toString("utf8");
  return { policy: validatePolicy(parseYamlSource(source, policyPath), policyPath), source: options.gitMode ? "external_worktree" : "worktree", relativePolicy };
}

function parseStrictTrustRoot(source, label) {
  const parsed = parseYamlSource(source, label);
  const errors = validateApprovalTrustRoot(parsed);
  if (errors.length > 0) throw new Error(`${label}: ${errors.join("; ")}`);
  return parsed;
}

function configureEvaluatorTrust(options, repoRoot, trustRootPath, targetBaseSha) {
  const relativeTrust = repoRelativePath(repoRoot, trustRootPath);
  if (options.gitMode && relativeTrust) {
    const fromBase = gitRegularBlob(repoRoot, targetBaseSha, relativeTrust, { allowMissing: true });
    if (!fromBase) throw new Error(`受保护 target base ${targetBaseSha} 不含 ${relativeTrust}；bootstrap 只能走精确 exemption，不能从 PR head 建立审批信任根`);
    parseStrictTrustRoot(fromBase.content.toString("utf8"), `${targetBaseSha}:${relativeTrust}`);
    const temporaryTrustDirectory = mkdtempSync(join(tmpdir(), "cfd-base-trust-"));
    temporaryDirectories.add(temporaryTrustDirectory);
    const materialized = join(temporaryTrustDirectory, "approval-trust.yaml");
    writeFileSync(materialized, fromBase.content, { mode: 0o600 });
    evaluatorEnvironment = { ...process.env, CFD_APPROVAL_TRUST_ROOT: materialized };
    return { source: "target_base", path: relativeTrust };
  }
  const source = readRegularWorktreeFile(trustRootPath, "approval trust root").toString("utf8");
  parseStrictTrustRoot(source, trustRootPath);
  evaluatorEnvironment = { ...process.env, CFD_APPROVAL_TRUST_ROOT: trustRootPath };
  return { source: options.gitMode ? "external_worktree" : "worktree", path: trustRootPath };
}

function canonicalChangedFiles(files, { gitDerived = false } = {}) {
  const normalized = files.map((path) => {
    const candidate = normalizePath(path);
    if (gitDerived && candidate !== path) {
      throw new Error(`Git path 必须保持原始 UTF-8/NFC repo-relative 形式，拒绝规范化别名：${JSON.stringify(path)}`);
    }
    return candidate;
  }).sort();
  if (new Set(normalized).size !== normalized.length) return [...new Set(normalized)];
  return normalized;
}

function gitBlob(repoRoot, headSha, path) {
  const result = gitRegularBlob(repoRoot, headSha, path, { allowMissing: true });
  return result ? { kind: "file", content: result.content, mode: result.mode } : { kind: "deleted", content: null, mode: null };
}

function worktreeBlob(repoRoot, path) {
  const fullPath = resolve(repoRoot, path);
  if (!existsSync(fullPath)) return { kind: "deleted", content: null };
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`changed path 必须是普通文件或已删除文件：${path}`);
  return { kind: "file", content: readFileSync(fullPath), mode: (stat.mode & 0o111) === 0 ? "100644" : "100755" };
}

function normalizedPolicyDigestContent(content, label, exemptionId) {
  const source = content.toString("utf8");
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  const exemptions = document.get("exemptions", true);
  if (!YAML.isSeq(exemptions)) throw new Error(`${label}: 无法规范化 exemptions[].head_content_digest`);
  const matching = exemptions.items.filter((item) => YAML.isMap(item) && item.get("id") === exemptionId);
  if (matching.length !== 1) throw new Error(`${label}: exemption ${exemptionId} 必须唯一存在于候选 policy`);
  const digestNode = matching[0].get("head_content_digest", true);
  if (!YAML.isScalar(digestNode) || !Array.isArray(digestNode.range)) throw new Error(`${label}: exemption ${exemptionId}.head_content_digest 无法定位`);
  const [start, valueEnd] = digestNode.range;
  const replacement = "sha256:<normalized-self-reference>";
  return Buffer.from(`${source.slice(0, start)}${replacement}${source.slice(valueEnd)}`, "utf8");
}

function changeSetDigest(files, policyPath, blobReader, normalizedExemptionId = null) {
  const hash = createHash("sha256");
  hash.update(Buffer.from("codex-feature-delivery/change-set/v3\0", "utf8"));
  for (const path of files) {
    hash.update(Buffer.from(path, "utf8"));
    hash.update(Buffer.from([0]));
    const blob = blobReader(path);
    if (blob.kind === "deleted") {
      hash.update(Buffer.from("deleted\0", "utf8"));
      continue;
    }
    const content = policyPath && path === policyPath && normalizedExemptionId
      ? normalizedPolicyDigestContent(blob.content, `${path} change-set digest`, normalizedExemptionId)
      : blob.content;
    if (!["100644", "100755"].includes(blob.mode)) throw new Error(`${path}: change-set blob mode 无效`);
    hash.update(Buffer.from(`file\0${blob.mode}\0${content.byteLength}\0`, "utf8"));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitTreeFiles(repoRoot, commitSha, rootPath) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-tree", "-rz", "--full-tree", commitSha, "--", rootPath], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-tree ${commitSha}:${rootPath} 失败：${String(result.stderr || result.stdout).trim()}`);
  const entries = [];
  for (const record of decodeGitPathOutput(result.stdout, `git ls-tree ${commitSha}:${rootPath}`).split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error(`${commitSha}:${rootPath} tree entry 编码无效`);
    const [mode, type, object] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const normalized = normalizePath(path);
    if (normalized !== path || !(path === rootPath || path.startsWith(`${rootPath}/`))) throw new Error(`${commitSha}:${path} 不是规范的 feature-root 子路径`);
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`${commitSha}:${path} 必须是普通 Git blob（拒绝 mode=${mode} type=${type} 的 symlink/tree/submodule）`);
    }
    entries.push({ mode, type, object, path });
  }
  if (entries.length > 5000) throw new Error(`${commitSha}:${rootPath} 文件数超过安全上限 5000`);
  return entries;
}

function gitObjectContent(repoRoot, object, label) {
  const sizeResult = spawnSync("git", ["-C", repoRoot, "cat-file", "-s", object], { encoding: "utf8" });
  if (sizeResult.status !== 0) throw new Error(`git cat-file -s ${label} 失败`);
  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error(`${label} blob 大小超过单文件安全上限 32 MiB`);
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", object], { encoding: null, maxBuffer: 33 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git cat-file ${label} 失败：${String(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function materializeFeatureRoot(repoRoot, headSha, featureRootRelative) {
  const directory = mkdtempSync(join(tmpdir(), "cfd-candidate-features-"));
  temporaryDirectories.add(directory);
  const materializedRoot = join(directory, "feature-root");
  mkdirSync(materializedRoot, { recursive: true });
  const entries = gitTreeFiles(repoRoot, headSha, featureRootRelative);
  let totalBytes = 0;
  for (const entry of entries) {
    const suffix = entry.path.slice(featureRootRelative.length).replace(/^\//, "");
    if (!suffix) throw new Error(`${headSha}:${featureRootRelative} feature_root 必须是目录，不能是文件`);
    const target = resolve(materializedRoot, suffix);
    if (repoRelativePath(materializedRoot, target) === null) throw new Error(`${headSha}:${entry.path} materialize 越界`);
    const content = gitObjectContent(repoRoot, entry.object, `${headSha}:${entry.path}`);
    totalBytes += content.byteLength;
    if (totalBytes > 128 * 1024 * 1024) throw new Error(`${headSha}:${featureRootRelative} 总大小超过安全上限 128 MiB`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
  }
  return materializedRoot;
}

function parseCanonicalYamlSource(source, label) {
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true, intAsBigInt: true });
  if (document.errors.length > 0) throw new Error(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

function canonicalRecord(value) {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (Array.isArray(value)) return `array:[${value.map(canonicalRecord).join(",")}]`;
  if (value && typeof value === "object") {
    return `object:{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalRecord(value[key])}`).join(",")}}`;
  }
  throw new Error(`ledger canonical value 含不支持类型 ${typeof value}`);
}

function appendOnlyLedgerErrors(repoRoot, targetBaseSha, headSha, featureRootRelative) {
  const errors = [];
  const baseEntries = gitTreeFiles(repoRoot, targetBaseSha, featureRootRelative);
  const manifests = baseEntries.filter((entry) => {
    const suffix = entry.path.slice(featureRootRelative.length).replace(/^\//, "");
    return suffix.split("/").length === 2 && suffix.endsWith("/feature.yaml");
  });
  for (const manifestEntry of manifests) {
    const manifestLabel = `${targetBaseSha}:${manifestEntry.path}`;
    let manifest;
    try {
      manifest = parseYamlSource(gitObjectContent(repoRoot, manifestEntry.object, manifestLabel).toString("utf8"), manifestLabel);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (manifest?.schema_version !== 2 || manifest?.kind !== "FeaturePackage") continue;
    const packagePath = dirname(manifestEntry.path).split(sep).join("/");
    for (const ledgerName of ["decisions.yaml", "evidence.yaml"]) {
      const ledgerPath = `${packagePath}/${ledgerName}`;
      try {
        const baseBlob = gitRegularBlob(repoRoot, targetBaseSha, ledgerPath);
        const headBlob = gitRegularBlob(repoRoot, headSha, ledgerPath);
        const baseLedger = parseCanonicalYamlSource(baseBlob.content.toString("utf8"), `${targetBaseSha}:${ledgerPath}`);
        const headLedger = parseCanonicalYamlSource(headBlob.content.toString("utf8"), `${headSha}:${ledgerPath}`);
        for (const field of ["schema_version", "kind", "feature_id"]) {
          if (canonicalRecord(baseLedger?.[field]) !== canonicalRecord(headLedger?.[field])) throw new Error(`${ledgerPath}: ${field} 不得改变`);
        }
        if (!Array.isArray(baseLedger?.entries) || !Array.isArray(headLedger?.entries)) throw new Error(`${ledgerPath}: entries 必须是数组`);
        if (headLedger.entries.length < baseLedger.entries.length) throw new Error(`${ledgerPath}: entries 不得截断（base=${baseLedger.entries.length}, head=${headLedger.entries.length}）`);
        for (let index = 0; index < baseLedger.entries.length; index += 1) {
          if (canonicalRecord(baseLedger.entries[index]) !== canonicalRecord(headLedger.entries[index])) {
            throw new Error(`${ledgerPath}: base entry[${index}] canonical 内容被改写；账本只允许尾部追加`);
          }
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  return errors;
}

function candidateGovernanceSource(repoRoot, headSha, path) {
  const blob = gitRegularBlob(repoRoot, headSha, path, { allowMissing: true });
  return blob ? blob.content.toString("utf8") : null;
}

function validateCandidateGovernanceFiles(options, repoRoot, targetBaseSha, headSha, paths, policyPath, trustRootPath, coveragePolicy, projectContext) {
  // External pins are commit authorizations. Explicit-file/worktree mode has no
  // immutable candidate commit, so it must never exercise this channel.
  if (!options.gitMode) throw new Error("external_digest_only 只接受 base/head Git 模式");
  const relativePolicy = repoRelativePath(repoRoot, policyPath);
  const relativeTrust = repoRelativePath(repoRoot, trustRootPath);
  let candidateProjectContext = projectContext;
  const configuredRegistryPath = repoRelativePath(repoRoot, projectContext.registryPath);
  if (paths.includes(".feature-delivery.yaml") || (configuredRegistryPath && paths.includes(configuredRegistryPath))) {
    const projectConfigBlob = gitRegularBlob(repoRoot, headSha, ".feature-delivery.yaml");
    const projectConfig = parseYamlSource(projectConfigBlob.content.toString("utf8"), `${headSha}:.feature-delivery.yaml`);
    const registryRelative = normalizePath(projectConfig?.paths?.repository_registry);
    const registryBlob = gitRegularBlob(repoRoot, headSha, registryRelative);
    candidateProjectContext = loadProjectContextFromSources({
      configSource: projectConfigBlob.content.toString("utf8"),
      registrySource: registryBlob.content.toString("utf8"),
      configPath: resolve(repoRoot, ".feature-delivery.yaml"),
      repositoryRoot: repoRoot,
      frameworkDir: FRAMEWORK_DIR,
    });
  }
  const snapshotPrefixes = coveragePolicy.protected_paths
    .filter((rule) => rule.match === "prefix" && rule.mode === "external_digest_only" && (rule.path === "policies" || rule.path.endsWith("/policies")))
    .map((rule) => rule.path);
  for (const path of paths) {
    const source = candidateGovernanceSource(repoRoot, headSha, path);
    const snapshotPrefix = snapshotPrefixes.find((prefix) => path.startsWith(`${prefix}/`));
    if (snapshotPrefix) {
      const suffix = path.slice(snapshotPrefix.length + 1);
      const match = suffix.match(/^([0-9a-f]{64})\.yaml$/);
      if (!match) throw new Error(`${headSha}:${path}: policy snapshot 路径必须是 ${snapshotPrefix}/<64 lowercase hex>.yaml`);
      const baseSnapshot = gitRegularBlob(repoRoot, targetBaseSha, path, { allowMissing: true });
      if (baseSnapshot) throw new Error(`${path}: 已归档 policy snapshot 不可修改或删除；必须保持 immutable`);
      if (source === null) throw new Error(`${headSha}:${path}: 新 policy snapshot 不得删除`);
      const validated = validateGatePolicySource(source, { label: `${headSha}:${path}`, frameworkDir: FRAMEWORK_DIR });
      const expectedDigest = `sha256:${match[1]}`;
      if (validated.digest !== expectedDigest) {
        throw new Error(`${headSha}:${path}: policy snapshot 内容 digest=${validated.digest} 与文件名 ${expectedDigest} 不一致`);
      }
      continue;
    }
    if (path === relativeTrust) {
      if (source === null) throw new Error(`${headSha}:${path}: approval trust root 不得删除`);
      parseStrictTrustRoot(source, `${headSha}:${path}`);
      continue;
    }
    if (path === relativePolicy) {
      if (source === null) throw new Error(`${headSha}:${path}: change coverage policy 不得删除`);
      const candidatePolicy = validatePolicy(parseYamlSource(source, `${headSha}:${path}`), `${headSha}:${path}`);
      if (candidatePolicy.repository_id !== candidateProjectContext.currentRepository.id
          || candidatePolicy.feature_root !== candidateProjectContext.config.paths.feature_root
          || candidatePolicy.required_gate !== candidateProjectContext.config.ci.required_gate) {
        throw new Error(`${headSha}:${path}: candidate coverage policy 与 project config 不一致`);
      }
      continue;
    }
    if (path.endsWith("/gate-policy.yaml") || path === "gate-policy.yaml") {
      if (source === null) throw new Error(`${headSha}:${path}: active gate policy 不得删除`);
      const validated = validateGatePolicySource(source, { label: `${headSha}:${path}`, frameworkDir: FRAMEWORK_DIR });
      const gatePolicyDirectory = dirname(path);
      const snapshotPath = `${gatePolicyDirectory === "." ? "" : `${gatePolicyDirectory}/`}policies/${validated.digest.slice(7)}.yaml`;
      const snapshot = gitRegularBlob(repoRoot, headSha, snapshotPath, { allowMissing: true });
      if (!snapshot || snapshot.content.toString("utf8") !== source || gatePolicyDigest(snapshot.content) !== validated.digest) {
        throw new Error(`${headSha}:${path}: active gate policy 必须有 bytes 完全相同的内容寻址 snapshot ${snapshotPath}`);
      }
    } else if (source === null) continue;
    else if (path.endsWith(".yaml") || path.endsWith(".yml")) {
      parseYamlSource(source, `${headSha}:${path}`);
    } else if (path.endsWith(".json")) {
      let candidate;
      try { candidate = JSON.parse(source); }
      catch (error) { throw new Error(`${headSha}:${path}: JSON 非法：${error.message}`); }
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${headSha}:${path}: JSON root 必须是 object`);
    }
  }
}

function jsonFromEvaluator(args) {
  const repositoryArgs = evaluatorRepositoryRoot ? ["--repository-root", evaluatorRepositoryRoot] : [];
  const result = run(process.execPath, [EVALUATOR, "--json", ...repositoryArgs, ...args], { env: evaluatorEnvironment });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { status: result.status, report: null, error: `evaluator 未返回 JSON：${result.stderr || result.stdout}` };
  }
  return { status: result.status, report, error: null };
}

function discoverPackages(featureRoot) {
  if (!existsSync(featureRoot) || !statSync(featureRoot).isDirectory()) throw new Error(`Feature root 不存在：${featureRoot}`);
  const packages = [];
  for (const name of readdirSync(featureRoot).sort()) {
    const packageDir = resolve(featureRoot, name);
    if (!statSync(packageDir).isDirectory() || !existsSync(resolve(packageDir, "feature.yaml"))) continue;
    let manifest = null;
    try { manifest = parseYamlSource(readFileSync(resolve(packageDir, "feature.yaml"), "utf8"), resolve(packageDir, "feature.yaml")); }
    catch { /* evaluator report carries the actionable parse failure */ }
    const inspection = jsonFromEvaluator(["--allow-legacy", packageDir]);
    packages.push({ name, packageDir, manifest, inspection });
  }
  const featureIds = new Map();
  for (const pkg of packages) {
    if (pkg.manifest?.schema_version !== 2 || pkg.manifest?.kind !== "FeaturePackage") continue;
    const id = pkg.manifest?.feature?.id;
    if (typeof id !== "string" || !id) continue;
    const previous = featureIds.get(id);
    if (previous) throw new Error(`重复 v2 feature.id=${id}: ${previous}, ${pkg.name}`);
    featureIds.set(id, pkg.name);
  }
  return packages;
}

function physicalPackageFiles(packageDir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = resolve(packageDir, entry.name);
    if (entry.isDirectory()) files.push(...physicalPackageFiles(fullPath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function managedPackagePaths(packages, featureRootRelative) {
  const managed = new Set();
  for (const pkg of packages) {
    const report = pkg.inspection.report;
    let relativePaths = [];
    if (pkg.manifest?.schema_version === 2 && pkg.manifest?.kind === "FeaturePackage") {
      relativePaths = ["feature.yaml", "evidence.yaml", "decisions.yaml", ...(pkg.manifest.artifacts ?? []).map((artifact) => artifact?.path)]
        .filter((path) => typeof path === "string" && path.length > 0)
        .map((path) => normalizePath(path));
    } else if (report?.legacy === true && report?.recognized === true && report?.verdict === "LEGACY_RECOGNIZED") {
      relativePaths = physicalPackageFiles(pkg.packageDir);
    }
    for (const relativePath of relativePaths) managed.add(`${featureRootRelative}/${pkg.name}/${relativePath}`);
  }
  return managed;
}

function changedPathsBetween(repoRoot, parentSha, commitSha) {
  const raw = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", parentSha, commitSha, "--"], null);
  return canonicalChangedFiles(decodeGitPathOutput(raw, `git diff ${parentSha}..${commitSha}`).split("\0").filter(Boolean), { gitDerived: true });
}

function treeEntryIdentity(repoRoot, commitSha, path) {
  const entry = gitTreeEntry(repoRoot, commitSha, path);
  return entry ? `${entry.mode}\0${entry.type}\0${entry.object}` : "deleted";
}

function analyzeCommitBoundary(repoRoot, targetBaseSha, headSha, managedPaths, featureRootRelative) {
  const ancestor = run("git", ["-C", repoRoot, "merge-base", "--is-ancestor", targetBaseSha, headSha]);
  if (ancestor.status !== 0) throw new Error(`target base ${targetBaseSha} 必须是 head ${headSha} 的祖先；请先更新分支`);
  const commits = String(git(repoRoot, ["rev-list", "--reverse", "--first-parent", `${targetBaseSha}..${headSha}`]))
    .trim().split("\n").filter(Boolean);
  let expectedParent = targetBaseSha;
  const steps = [];
  for (const commit of commits) {
    const ancestry = String(git(repoRoot, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
    const parents = ancestry.slice(1);
    if (parents.length !== 1) throw new Error(`PR first-parent 链不允许 merge commit：${commit}`);
    if (parents[0] !== expectedParent) throw new Error(`PR first-parent 链不连续：${commit} 的 parent=${parents[0]}，期望 ${expectedParent}`);
    const paths = changedPathsBetween(repoRoot, expectedParent, commit);
    const ordinaryPaths = paths.filter((path) => !(path === featureRootRelative || path.startsWith(`${featureRootRelative}/`)));
    steps.push({ commit, parent: expectedParent, paths, ordinaryPaths });
    expectedParent = commit;
  }
  if (expectedParent !== headSha) throw new Error(`first-parent 链未终止于候选 head ${headSha}`);
  const lastImplementationIndex = steps.reduce((last, step, index) => step.ordinaryPaths.length > 0 ? index : last, -1);
  const codeSha = lastImplementationIndex < 0 ? null : steps[lastImplementationIndex].commit;
  for (const step of steps.slice(lastImplementationIndex + 1)) {
    const undeclared = step.paths.filter((path) => !managedPaths.has(path));
    if (undeclared.length > 0) throw new Error(`${step.commit}: implementation commit 后只允许 evaluator 识别的 Package 管理文件；发现 ${undeclared.join(", ")}`);
  }
  if (codeSha) {
    const ordinaryPaths = [...new Set(steps.flatMap((step) => step.ordinaryPaths))].sort();
    for (const path of ordinaryPaths) {
      if (treeEntryIdentity(repoRoot, codeSha, path) !== treeEntryIdentity(repoRoot, headSha, path)) {
        throw new Error(`${path}: 最终普通路径 tree 与 implementation commit ${codeSha} 不一致`);
      }
    }
  }
  return { commits, steps, codeSha };
}

function latestDecision(packageDir, id) {
  const path = resolve(packageDir, "decisions.yaml");
  if (!existsSync(path)) return null;
  const ledger = parseYamlSource(readFileSync(path, "utf8"), path);
  return Array.isArray(ledger.entries) ? ledger.entries.find((entry) => entry?.id === id) ?? null : null;
}

function manifestFor(packageDir) {
  const path = resolve(packageDir, "feature.yaml");
  return parseYamlSource(readFileSync(path, "utf8"), path);
}

function normalizedRepoScope(scope, repoId) {
  if (!scope || scope.repository !== repoId || typeof scope.path !== "string") return null;
  if (scope.path === ".") return ".";
  try { return normalizePath(scope.path); } catch { return null; }
}

function scopeCovers(scope, path) {
  return scope === "." || path === scope || path.startsWith(`${scope}/`);
}

function gatePassed(packageDir, gate, instance = null) {
  const args = ["--gate", gate];
  if (instance) args.push("--instance", instance);
  args.push(packageDir);
  const result = jsonFromEvaluator(args);
  const gateReport = result.report?.gates?.[0];
  return {
    ok: result.status === 0 && result.report?.valid === true && result.report?.verdict === "PASSED" && gateReport?.state === "passed",
    decisionId: gateReport?.decision_id ?? null,
    reasons: result.error ? [result.error] : [...(result.report?.errors ?? []), ...(gateReport?.reasons ?? [])],
  };
}

function decisionHasCodeRef(packageDir, decisionId, repoId, codeSha) {
  const decision = latestDecision(packageDir, decisionId);
  return Boolean(decision && decision.subject?.code_refs?.some((reference) => reference.repository === repoId && reference.sha === codeSha));
}

function coverageByPackage(pkg, path, context) {
  if (pkg.inspection.report?.legacy) return { covered: false, reasons: ["legacy v1 不能授权新变更"] };
  if (pkg.inspection.report?.valid !== true) return { covered: false, reasons: pkg.inspection.report?.errors ?? [pkg.inspection.error ?? "package invalid"] };
  const manifest = manifestFor(pkg.packageDir);
  const g2 = gatePassed(pkg.packageDir, "G2");
  if (!g2.ok) return { covered: false, reasons: [`G2 未通过：${g2.reasons.join("; ")}`] };
  const authorization = latestDecision(pkg.packageDir, g2.decisionId)?.authorization;
  if (!authorization || !authorization.repositories?.includes(context.repoId)) return { covered: false, reasons: [`G2 ${g2.decisionId ?? "UNKNOWN"} 未授权 repository=${context.repoId}`] };
  if (!context.baseSha) return { covered: false, reasons: ["缺少 base SHA，无法验证 G2 base_ref"] };
  if (!authorization.base_refs?.some((reference) => reference.repository === context.repoId && reference.sha === context.baseSha)) return { covered: false, reasons: [`G2 ${g2.decisionId} 未绑定当前 target base ${context.repoId}@${context.baseSha}`] };
  const scopes = (authorization.paths ?? []).map((scope) => normalizedRepoScope(scope, context.repoId)).filter(Boolean);
  if (!scopes.some((scope) => scopeCovers(scope, path))) return { covered: false, reasons: [`G2 ${g2.decisionId} paths 未覆盖 ${path}`] };

  const gates = [{ gate: "G2", instance: "feature", decision_id: g2.decisionId }];
  if (GATE_ORDER[context.requiredGate] >= GATE_ORDER.G3) {
    if (!context.codeSha) return { covered: false, reasons: ["metadata-only change 没有 implementation code SHA，不能验证 G3 code_ref"] };
    const pathCandidates = (manifest.slices ?? []).flatMap((slice) => (slice.paths ?? [])
      .map((scope) => normalizedRepoScope(scope, context.repoId))
      .filter((scope) => scope && scopeCovers(scope, path))
      .map((scope) => ({ slice, scope })));
    const maximumSpecificity = Math.max(...pathCandidates.map((candidate) => candidate.scope === "." ? 0 : candidate.scope.length), -1);
    const slices = pathCandidates
      .filter((candidate) => (candidate.scope === "." ? 0 : candidate.scope.length) === maximumSpecificity)
      .map((candidate) => candidate.slice)
      .filter((slice, index, all) => all.findIndex((item) => item.id === slice.id) === index)
      .filter((slice) => slice.authorization_decision_id === g2.decisionId);
    if (slices.length === 0) return { covered: false, reasons: [`没有 repository=${context.repoId} 且绑定 G2=${g2.decisionId} 的 Slice`] };
    for (const slice of slices) {
      const g3 = gatePassed(pkg.packageDir, "G3", slice.id);
      if (!g3.ok) return { covered: false, reasons: [`G3/${slice.id} 未通过：${g3.reasons.join("; ")}`] };
      if (!decisionHasCodeRef(pkg.packageDir, g3.decisionId, context.repoId, context.codeSha)) return { covered: false, reasons: [`G3/${slice.id} 未绑定 implementation commit ${context.repoId}@${context.codeSha}`] };
      gates.push({ gate: "G3", instance: slice.id, decision_id: g3.decisionId });
    }
  }
  if (GATE_ORDER[context.requiredGate] >= GATE_ORDER.G4) {
    const g4 = gatePassed(pkg.packageDir, "G4");
    if (!g4.ok) return { covered: false, reasons: [`G4 未通过：${g4.reasons.join("; ")}`] };
    if (!decisionHasCodeRef(pkg.packageDir, g4.decisionId, context.repoId, context.codeSha)) return { covered: false, reasons: [`G4 未绑定 implementation commit ${context.repoId}@${context.codeSha}`] };
    gates.push({ gate: "G4", instance: "feature", decision_id: g4.decisionId });
  }
  return { covered: true, feature_id: manifest.feature?.id, profile: manifest.feature?.profile, package_dir: pkg.packageDir, authorization_decision_id: g2.decisionId, gates, scopes };
}

function featureMetadataPackage(path, featureRootRelative, packages) {
  if (!featureRootRelative) return null;
  const prefix = featureRootRelative.replace(/\/$/, "");
  if (!path.startsWith(`${prefix}/`)) return null;
  const packageName = path.slice(prefix.length + 1).split("/")[0];
  return packages.find((pkg) => pkg.name === packageName) ?? { name: packageName, missing: true };
}

function emit(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.valid) {
    process.stdout.write(`CHANGE_COVERAGE_OK repo=${report.repository_id} files=${report.changed_files.length} policy_source=${report.policy_source}\n`);
    if (report.exemption) process.stdout.write(`EXEMPTION ${report.exemption.id} owner=${report.exemption.owner} expires_at=${report.exemption.expires_at} digest=${report.change_set_digest}\n`);
    for (const item of report.coverage ?? []) process.stdout.write(`COVERED ${item.path} by ${item.feature_id ?? item.kind} ${item.authorization_decision_id ?? ""}\n`);
  } else {
    process.stderr.write(`CHANGE_COVERAGE_BLOCKED repo=${report.repository_id ?? "UNKNOWN"}\n`);
    for (const error of report.errors ?? []) process.stderr.write(`  - ${error}\n`);
  }
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); usage(2); }
  // Keep the CLI's lexical checkout root. Resolving a worktree symlink here can
  // incorrectly reclassify an in-repo policy/trust path as an external mount.
  const repoRoot = resolve(options.repoRoot);
  let projectContext;
  try {
    if (options.gitMode) {
      const configPath = requestedPath(repoRoot, options.projectConfig ?? ".feature-delivery.yaml");
      const relativeConfig = repoRelativePath(repoRoot, configPath);
      if (relativeConfig !== ".feature-delivery.yaml") throw new Error("项目配置必须是项目根 .feature-delivery.yaml");
      const baseCommit = String(git(repoRoot, ["rev-parse", "--verify", `${options.base}^{commit}`])).trim();
      const configBlob = gitRegularBlob(repoRoot, baseCommit, relativeConfig);
      const preliminary = parseYamlSource(configBlob.content.toString("utf8"), `${baseCommit}:${relativeConfig}`);
      const registryRelative = normalizePath(preliminary?.paths?.repository_registry);
      const registryBlob = gitRegularBlob(repoRoot, baseCommit, registryRelative);
      projectContext = loadProjectContextFromSources({
        configSource: configBlob.content.toString("utf8"),
        registrySource: registryBlob.content.toString("utf8"),
        configPath,
        repositoryRoot: repoRoot,
        frameworkDir: FRAMEWORK_DIR,
      });
    } else {
      projectContext = loadProjectContext({ projectConfig: options.projectConfig, repositoryRoot: repoRoot, frameworkDir: FRAMEWORK_DIR });
    }
  } catch (error) {
    const report = { valid: false, verdict: "INVALID", repository_id: options.repoId, changed_files: [], errors: [error.message], warnings: [] };
    emit(report, options.json);
    process.exit(2);
  }
  const policyPath = requestedPath(repoRoot, options.policy ?? projectContext.governance.changeCoveragePolicy);
  const trustPath = requestedPath(repoRoot, options.trustRoot ?? projectContext.governance.trustRoot);
  let targetBaseSha = options.baseSha;
  let diffBaseSha = null;
  let headSha = null;
  let codeSha = options.codeSha;
  let changedFiles;
  try {
    if (options.gitMode) {
      headSha = String(git(repoRoot, ["rev-parse", "--verify", `${options.head}^{commit}`])).trim();
      targetBaseSha = String(git(repoRoot, ["rev-parse", "--verify", `${options.base}^{commit}`])).trim();
      const ancestor = run("git", ["-C", repoRoot, "merge-base", "--is-ancestor", targetBaseSha, headSha]);
      if (ancestor.status !== 0) throw new Error(`target base ${targetBaseSha} 必须是 head ${headSha} 的祖先；请先更新分支`);
      diffBaseSha = String(git(repoRoot, ["merge-base", targetBaseSha, headSha])).trim();
      const raw = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", diffBaseSha, headSha, "--"], null);
      changedFiles = canonicalChangedFiles(decodeGitPathOutput(raw, `git diff ${diffBaseSha}..${headSha}`).split("\0").filter(Boolean), { gitDerived: true });
    } else changedFiles = canonicalChangedFiles(options.files);

    const loaded = loadPolicy(options, repoRoot, policyPath, targetBaseSha, headSha);
    const policy = loaded.policy;
    if (policy.repository_id !== projectContext.currentRepository.id) throw new Error(`coverage policy repository_id=${policy.repository_id} 与项目配置 current_id=${projectContext.currentRepository.id} 不一致`);
    if (policy.feature_root !== projectContext.config.paths.feature_root) throw new Error(`coverage policy feature_root=${policy.feature_root} 与项目配置 feature_root=${projectContext.config.paths.feature_root} 不一致`);
    if (policy.required_gate !== projectContext.config.ci.required_gate) throw new Error(`coverage policy required_gate=${policy.required_gate} 与项目配置 ci.required_gate=${projectContext.config.ci.required_gate} 不一致`);
    if (options.repoId && options.repoId !== policy.repository_id) throw new Error(`--repo-id 只能断言配置值，不能覆盖：${options.repoId} != ${policy.repository_id}`);
    if (options.requiredGate && options.requiredGate !== policy.required_gate) throw new Error(`--required-gate 只能断言配置值，不能覆盖：${options.requiredGate} != ${policy.required_gate}`);
    const repoId = policy.repository_id;
    const requiredGate = policy.required_gate;
    const featureRootPath = projectContext.featureRoot;
    if (options.featureRoot && requestedPath(repoRoot, options.featureRoot) !== featureRootPath) throw new Error("--feature-root 只能断言项目配置值，不能覆盖");
    const featureRootRelative = repoRelativePath(repoRoot, featureRootPath);
    if (options.gitMode && !featureRootRelative) throw new Error("git 模式的 feature-root 必须是 lexical repo-relative 路径");
    evaluatorRepositoryRoot = repoRoot;
    evaluatorEnvironment = { ...evaluatorEnvironment, CFD_PROJECT_CONFIG: projectContext.configPath };
    let trust = null;
    if (!options.gitMode || loaded.source !== "bootstrap_head") trust = configureEvaluatorTrust(options, repoRoot, trustPath, targetBaseSha);
    const evaluatorFeatureRoot = options.gitMode
      ? materializeFeatureRoot(repoRoot, headSha, featureRootRelative)
      : featureRootPath;
    const packages = discoverPackages(evaluatorFeatureRoot);
    const managedPaths = managedPackagePaths(packages, featureRootRelative);
    let commitBoundary = null;
    if (options.gitMode) {
      const packagePrefix = `${featureRootRelative}/`;
      const undeclaredPackagePaths = changedFiles.filter((path) => {
        if (!path.startsWith(packagePrefix)) return false;
        const suffix = path.slice(packagePrefix.length);
        return suffix.includes("/") && !managedPaths.has(path);
      });
      if (undeclaredPackagePaths.length > 0) {
        throw new Error(`Feature Package 内存在 evaluator 未声明的路径：${undeclaredPackagePaths.join(", ")}`);
      }
      commitBoundary = analyzeCommitBoundary(repoRoot, targetBaseSha, headSha, managedPaths, featureRootRelative);
      codeSha = commitBoundary.codeSha;
      let previous = targetBaseSha;
      const ledgerErrors = [];
      for (const commit of commitBoundary.commits) {
        ledgerErrors.push(...appendOnlyLedgerErrors(repoRoot, previous, commit, featureRootRelative));
        previous = commit;
      }
      if (ledgerErrors.length > 0) throw new Error(`v2 append-only ledger 校验失败：${ledgerErrors.join("; ")}`);
    }
    const blobReader = (path) => options.gitMode ? gitBlob(repoRoot, headSha, path) : worktreeBlob(repoRoot, path);
    const rawDigest = changeSetDigest(changedFiles, loaded.relativePolicy, blobReader);
    let digest = rawDigest;

    const externalDigestPaths = changedFiles.filter((path) => protectedRuleForPath(policy, path)?.mode === "external_digest_only");
    if (options.gitMode && loaded.source !== "bootstrap_head" && externalDigestPaths.length > 0) {
      const nonGovernancePaths = changedFiles.filter((path) => protectedRuleForPath(policy, path)?.mode !== "external_digest_only");
      if (nonGovernancePaths.length > 0) {
        throw new Error(`external_digest_only governance 变更必须独立提交；非 governance 路径：${nonGovernancePaths.join(", ")}`);
      }
      const relativeTrust = repoRelativePath(repoRoot, trustPath);
      if (relativeTrust && externalDigestPaths.includes(relativeTrust)
          && (changedFiles.length !== 1 || changedFiles[0] !== relativeTrust)) {
        throw new Error(`approval trust root 轮换必须是 trust-only 变更；不得与其他 runtime TCB 路径一起提交：${changedFiles.join(", ")}`);
      }
      if (options.governanceDigest !== rawDigest) {
        throw new Error(`runtime TCB/approval-trust 变更必须由仓库外 CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST 精确 pin 当前 digest=${rawDigest}`);
      }
      validateCandidateGovernanceFiles(options, repoRoot, targetBaseSha, headSha, externalDigestPaths, policyPath, trustPath, policy, projectContext);
      const report = {
        valid: true,
        verdict: "GOVERNANCE_DIGEST_APPLIED",
        repository_id: repoId,
        required_gate: requiredGate,
        policy_source: loaded.source,
        target_base_sha: targetBaseSha,
        diff_base_sha: diffBaseSha,
        head_sha: headSha,
        code_sha: codeSha,
        changed_files: changedFiles,
        change_set_digest: rawDigest,
        exemption: null,
        coverage: externalDigestPaths.map((path) => ({ path, kind: "EXTERNAL_TCB_DIGEST" })),
        errors: [],
        warnings: ["runtime TCB/governance 候选已完成适用的结构校验；仓库外管理员 digest 是独立授权通道。"],
      };
      emit(report, options.json);
      process.exit(0);
    }

    const now = Date.now();
    const exemptionCandidates = policy.exemptions.filter((exemption) => Date.parse(exemption.expires_at) > now
      && JSON.stringify(exemption.changed_files) === JSON.stringify(changedFiles));
    const evaluatedExemptions = exemptionCandidates.map((exemption) => ({
      exemption,
      digest: changeSetDigest(changedFiles, loaded.relativePolicy, blobReader, exemption.id),
    }));
    const matchingExemptions = evaluatedExemptions.filter(({ exemption, digest: candidateDigest }) => exemption.head_content_digest === candidateDigest);
    if (matchingExemptions.length > 1) throw new Error(`多个 exemption 同时匹配：${matchingExemptions.map(({ exemption }) => exemption.id).join(", ")}`);
    if (matchingExemptions.length === 1) {
      const { exemption, digest: exemptionDigest } = matchingExemptions[0];
      digest = exemptionDigest;
      if (loaded.source === "bootstrap_head" && options.bootstrapDigest !== digest) {
        throw new Error(`bootstrap-head exemption 还必须由仓库外 CFD_BOOTSTRAP_APPROVAL_DIGEST 精确 pin 当前 digest=${digest}`);
      }
      const report = { valid: true, verdict: "EXEMPTION_APPLIED", repository_id: repoId, required_gate: requiredGate, policy_source: loaded.source, target_base_sha: targetBaseSha, diff_base_sha: diffBaseSha, head_sha: headSha, code_sha: codeSha, changed_files: changedFiles, change_set_digest: digest, exemption: { id: exemption.id, owner: exemption.owner, rationale: exemption.rationale, approval_reference: exemption.approval_reference, expires_at: exemption.expires_at }, coverage: [], errors: [], warnings: loaded.source === "bootstrap_head" ? ["首次接入由仓库外 digest pin 授权 head policy；合并后 CI 必须从受保护 target base policy 评估。"] : [] };
      emit(report, options.json);
      process.exit(0);
    }

    const coverage = [];
    const errors = [];
    const context = { repoId, requiredGate, baseSha: targetBaseSha, codeSha };
    for (const path of changedFiles) {
      const protectedRule = protectedRuleForPath(policy, path);
      if (protectedRule?.mode === "exemption_only") {
        errors.push(`${path}: protected governance root 只能由受保护 base 中预登记的精确 exemption 变更；普通 Feature Package 不得授权`);
        continue;
      }
      if (protectedRule?.mode === "external_digest_only") {
        errors.push(`${path}: external_digest_only governance root 只能由独立仓库外 digest 通道授权`);
        continue;
      }
      const metadataPackage = featureMetadataPackage(path, featureRootRelative, packages);
      if (metadataPackage) {
        if (options.gitMode && !managedPaths.has(path)) {
          errors.push(`${path}: 不属于 evaluator 识别的 Package 管理文件；禁止用 Feature 目录夹带未声明文件`);
          continue;
        }
        if (metadataPackage.missing) {
          errors.push(`${path}: ${featureRootRelative} 下的路径不属于含 feature.yaml 的 Feature Package`);
          continue;
        }
        const report = metadataPackage.inspection.report;
        const accepted = (metadataPackage.inspection.status === 0 && report?.valid === true)
          || (report?.valid === false && report?.legacy === true && report?.recognized === true && report?.verdict === "LEGACY_RECOGNIZED");
        if (!accepted) errors.push(`${path}: Feature Package ${metadataPackage.name} 校验失败：${report?.errors?.join("; ") || metadataPackage.inspection.error || report?.verdict}`);
        else coverage.push({ path, kind: report.legacy ? "LEGACY_METADATA_PIN" : "FEATURE_PACKAGE_METADATA", feature_id: report.feature?.id ?? metadataPackage.name, package_dir: metadataPackage.packageDir });
        continue;
      }
      const candidates = [];
      const rejected = [];
      const pathContext = protectedRule?.mode === "controlled_g4_or_exemption" ? { ...context, requiredGate: "G4" } : context;
      for (const pkg of packages) {
        const result = coverageByPackage(pkg, path, pathContext);
        if (result.covered && protectedRule?.mode === "controlled_g4_or_exemption" && result.profile !== "controlled") rejected.push(`${pkg.name}: protected policy root 要求 controlled Profile + G4`);
        else if (result.covered) candidates.push(result);
        else rejected.push(`${pkg.name}: ${result.reasons.join("; ")}`);
      }
      const effectiveRequiredGate = pathContext.requiredGate;
      if (candidates.length === 0) errors.push(`${path}: 没有 v2 Package 同时覆盖当前 G2 repo/path/target-base 与 ${effectiveRequiredGate} Gate/implementation-commit；${rejected.join(" | ") || "未发现任何 Feature Package"}`);
      else coverage.push({ path, ...candidates[0], additional_candidates: candidates.slice(1).map((item) => item.feature_id) });
    }
    const report = { valid: errors.length === 0, verdict: errors.length === 0 ? "COVERED" : "BLOCKED", repository_id: repoId, required_gate: requiredGate, policy_source: loaded.source, approval_trust_source: trust?.source ?? null, feature_root: featureRootRelative ?? featureRootPath, target_base_sha: targetBaseSha, diff_base_sha: diffBaseSha, base_sha: targetBaseSha, head_sha: headSha, code_sha: codeSha, changed_files: changedFiles, change_set_digest: digest, exemption: null, coverage, errors, warnings: loaded.source === "bootstrap_head" ? ["首次接入从 head 建立 coverage policy；本次未匹配 bootstrap exemption。"] : [] };
    emit(report, options.json);
    process.exit(report.valid ? 0 : 1);
  } catch (error) {
    const report = { valid: false, verdict: "INVALID", repository_id: options.repoId, target_base_sha: targetBaseSha, diff_base_sha: diffBaseSha, head_sha: headSha, code_sha: codeSha, changed_files: changedFiles ?? [], errors: [error.message], warnings: [] };
    emit(report, options.json);
    process.exit(2);
  }
}

if (isDirectInvocation()) main();
