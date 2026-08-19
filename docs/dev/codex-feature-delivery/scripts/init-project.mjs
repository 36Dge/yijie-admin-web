#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { safeProjectPath } from "./project-context.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID_RE = /^[a-z][a-z0-9._-]*$/;
const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function usage(code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: init-project.mjs --project-root DIR --project-id ID --repository-id ID --actor-id ID [options]

Options:
  --project-name NAME    default: project-id
  --framework-root PATH  default: docs/dev/codex-feature-delivery
  --feature-root PATH    default: docs/features
  --primary-branch NAME  default: current symbolic Git branch; required when HEAD is detached
  --ci github|none       default: none
  -h, --help
`);
  process.exit(code);
}

const options = {
  projectRoot: null,
  projectId: null,
  projectName: null,
  repositoryId: null,
  actorId: null,
  frameworkRoot: "docs/dev/codex-feature-delivery",
  featureRoot: "docs/features",
  primaryBranch: null,
  ci: "none",
};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const take = () => {
    const value = args[++index];
    if (!value) fail(`${arg} 缺少值`, 2);
    return value;
  };
  if (arg === "-h" || arg === "--help") usage(0);
  if (arg === "--project-root") options.projectRoot = take();
  else if (arg === "--project-id") options.projectId = take();
  else if (arg === "--project-name") options.projectName = take();
  else if (arg === "--repository-id") options.repositoryId = take();
  else if (arg === "--actor-id") options.actorId = take();
  else if (arg === "--framework-root") options.frameworkRoot = take();
  else if (arg === "--feature-root") options.featureRoot = take();
  else if (arg === "--primary-branch") options.primaryBranch = take();
  else if (arg === "--ci") options.ci = take();
  else fail(`未知参数：${arg}`, 2);
}
if (!options.projectRoot || !options.projectId || !options.repositoryId || !options.actorId) usage(2);
options.projectName ??= options.projectId;
if (!options.projectName.trim() || /[\r\n]/.test(options.projectName)) fail("project-name 必须是非空单行显示名称", 2);
if (!ID_RE.test(options.projectId) || !ID_RE.test(options.repositoryId)) fail("project-id/repository-id 必须符合小写稳定 ID 规则", 2);
if (!ACTOR_RE.test(options.actorId)) fail("actor-id 格式无效", 2);
if (!['github', 'none'].includes(options.ci)) fail("--ci 必须是 github|none", 2);
for (const [label, value] of [["framework-root", options.frameworkRoot], ["feature-root", options.featureRoot]]) {
  try { safeProjectPath(value, label); } catch (error) { fail(error.message, 2); }
}
for (const [left, right] of [[options.frameworkRoot, options.featureRoot], [options.frameworkRoot, ".feature-delivery"], [options.featureRoot, ".feature-delivery"]]) {
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) fail("framework-root、feature-root、默认 governance root 必须互不重叠", 2);
}

const rootProbe = spawnSync("git", ["-C", resolve(options.projectRoot), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootProbe.status !== 0 || !rootProbe.stdout.trim()) fail("--project-root 必须是现有 Git worktree 根", 2);
const projectRoot = realpathSync(rootProbe.stdout.trim());
if (realpathSync(resolve(options.projectRoot)) !== projectRoot) fail(`--project-root 必须精确指向 Git 根：${projectRoot}`, 2);
if (!options.primaryBranch) {
  const branchProbe = spawnSync("git", ["-C", projectRoot, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  if (branchProbe.status !== 0 || !branchProbe.stdout.trim()) {
    fail("无法从当前 HEAD 探测 primary branch（例如 detached HEAD）；请显式提供 --primary-branch NAME", 2);
  }
  options.primaryBranch = branchProbe.stdout.trim();
}
if (options.primaryBranch.startsWith("refs/")) fail("--primary-branch 必须是 short branch name，不能使用 refs/ 前缀", 2);
const branchValidation = spawnSync("git", ["-C", projectRoot, "check-ref-format", "--branch", options.primaryBranch], { encoding: "utf8" });
if (branchValidation.status !== 0 || !branchValidation.stdout.trim()) fail(`--primary-branch 不是有效 Git branch name：${options.primaryBranch}`, 2);
options.primaryBranch = branchValidation.stdout.trim();
const configTarget = join(projectRoot, ".feature-delivery.yaml");
const governanceTarget = join(projectRoot, ".feature-delivery");
const frameworkTarget = join(projectRoot, ...options.frameworkRoot.split("/"));
const workflowTarget = join(projectRoot, ".github/workflows/feature-delivery-coverage.yml");
const pullRequestTemplateTarget = join(projectRoot, ".github/pull_request_template.md");
const featureRootTarget = join(projectRoot, ...options.featureRoot.split("/"));
const featureRootExisted = existsSync(featureRootTarget);
for (const target of [configTarget, governanceTarget, frameworkTarget, ...(options.ci === "github" ? [workflowTarget, pullRequestTemplateTarget] : [])]) {
  if (existsSync(target)) fail(`目标已存在，不会覆盖：${target}`);
}

const originProbe = spawnSync("git", ["-C", projectRoot, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
const repositoryUrl = originProbe.status === 0 && originProbe.stdout.trim() ? originProbe.stdout.trim() : `local:${options.repositoryId}`;
if (/\s|\0/.test(repositoryUrl)) fail("Git origin 不是安全的 canonical repository identifier", 2);

const stage = mkdtempSync(join(projectRoot, ".cfd-init.tmp-"));
const created = [];
function cleanup() { rmSync(stage, { recursive: true, force: true }); }
process.once("exit", cleanup);

const stagedFramework = join(stage, "framework");
const include = new Set([
  "CODEX_PLAYBOOK.md", "DOCUMENT_CATALOG.md", "HANDBOOK.md", "MIGRATION_V1_TO_V2.md", "PROJECT_ADOPTION.md",
  "QUALITY_GATES.md", "QUICKSTART.md", "README.md", "checklists", "config", "examples", "integrations", "gate-policy.yaml",
  "policies", "schemas", "scripts", "templates", "tests", "package.json", "package-lock.json", "RELEASE-MANIFEST.json",
]);
mkdirSync(stagedFramework, { recursive: true });
function copyTreePreservingMode(source, target) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) fail(`发行包不得包含 symlink：${source}`);
  if (metadata.isDirectory()) {
    mkdirSync(target, { mode: metadata.mode & 0o777 });
    for (const entry of readdirSync(source)) copyTreePreservingMode(join(source, entry), join(target, entry));
    chmodSync(target, metadata.mode & 0o777);
    return;
  }
  if (!metadata.isFile()) fail(`发行包不得包含 special file：${source}`);
  cpSync(source, target, { errorOnExist: true });
  chmodSync(target, metadata.mode & 0o777);
}
for (const entry of readdirSync(SOURCE_ROOT, { withFileTypes: true })) {
  if (!include.has(entry.name)) continue;
  copyTreePreservingMode(join(SOURCE_ROOT, entry.name), join(stagedFramework, entry.name));
}
if (!existsSync(join(stagedFramework, "package-lock.json"))) fail("发行包缺少 package-lock.json；请先在发行包运行 npm install --package-lock-only");

const q = (value) => JSON.stringify(String(value));
const configSource = `schema_version: 1
kind: FeatureDeliveryProject
project:
  id: ${q(options.projectId)}
  display_name: ${q(options.projectName)}
paths:
  framework_root: ${q(options.frameworkRoot)}
  feature_root: ${q(options.featureRoot)}
  governance_root: .feature-delivery
  repository_registry: .feature-delivery/repository-registry.yaml
repository:
  current_id: ${q(options.repositoryId)}
defaults:
  profile: standard
  delivery_target: local_engineering
  data_classification: internal
tooling:
  package_manager: null
  commands: {test: null, lint: null, build: null}
scm:
  provider: git
  primary_branch: ${q(options.primaryBranch)}
ci:
  provider: ${options.ci}
  required_gate: G3
  status_context: feature-delivery/trusted-coverage-status
identity:
  default_actor_id: ${q(options.actorId)}
`;
writeFileSync(join(stage, "project-config.yaml"), configSource);
const stagedGovernance = join(stage, "governance");
mkdirSync(stagedGovernance);
writeFileSync(join(stagedGovernance, "approval-trust.yaml"), "schema_version: 1\nkind: FeatureDeliveryApprovalTrust\nkeys: []\n");
writeFileSync(join(stagedGovernance, "legacy-v1-allowlist.txt"), "# Empty in newly initialized projects.\n");
writeFileSync(join(stagedGovernance, "repository-registry.yaml"), `schema_version: 1
kind: FeatureDeliveryRepositoryRegistry
repositories:
  - id: ${q(options.repositoryId)}
    name: ${q(options.repositoryId)}
    url: ${q(repositoryUrl)}
    root: "."
    kind: current
`);
const protectedRules = [
  ...(options.ci === "github" ? [{ path: ".github/workflows", match: "prefix", mode: "external_digest_only" }] : []),
  { path: ".feature-delivery.yaml", match: "exact", mode: "external_digest_only" },
  { path: options.frameworkRoot, match: "prefix", mode: "controlled_g4_or_exemption" },
  ...["gate-policy.yaml", "package.json", "package-lock.json", "RELEASE-MANIFEST.json"].map((name) => ({ path: `${options.frameworkRoot}/${name}`, match: "exact", mode: "external_digest_only" })),
  ...["policies", "schemas", "scripts"].map((name) => ({ path: `${options.frameworkRoot}/${name}`, match: "prefix", mode: "external_digest_only" })),
  { path: ".feature-delivery", match: "prefix", mode: "controlled_g4_or_exemption" },
  ...["approval-trust.yaml", "change-coverage-policy.yaml", "legacy-v1-allowlist.txt", "repository-registry.yaml"].map((name) => ({ path: `.feature-delivery/${name}`, match: "exact", mode: "external_digest_only" })),
];
writeFileSync(join(stagedGovernance, "change-coverage-policy.yaml"), `schema_version: 1
kind: FeatureChangeCoveragePolicy
repository_id: ${q(options.repositoryId)}
feature_root: ${q(options.featureRoot)}
required_gate: G3
protected_paths:
${protectedRules.map((rule) => `  - path: ${q(rule.path)}\n    match: ${rule.match}\n    mode: ${rule.mode}`).join("\n")}
exemptions: []
`);

if (options.ci === "github") {
  let workflow = readFileSync(join(SOURCE_ROOT, "integrations/github/feature-delivery-coverage.yml"), "utf8");
  const replacements = {
    __FRAMEWORK_ROOT__: options.frameworkRoot,
    __FEATURE_ROOT__: options.featureRoot,
    __REPOSITORY_ID__: options.repositoryId,
    __TRUSTED_ENVIRONMENT__: "feature-delivery-trusted",
  };
  for (const [token, value] of Object.entries(replacements)) workflow = workflow.replaceAll(token, () => value);
  if (/__[A-Z0-9_]+__/.test(workflow)) fail("GitHub workflow template 仍有未替换 token");
  for (const required of ["pull_request_target:", "state=pending", "if: ${{ always()", "feature-delivery/trusted-coverage-status", "EXPECTED_BASE_SHA", "EXPECTED_HEAD_SHA"]) {
    if (!workflow.includes(required)) fail(`GitHub workflow template 缺少安全控制：${required}`);
  }
  writeFileSync(join(stage, "workflow.yml"), workflow);
  cpSync(join(SOURCE_ROOT, "integrations/github/pull_request_template.md"), join(stage, "pull_request_template.md"));
}

try {
  mkdirSync(dirname(frameworkTarget), { recursive: true });
  renameSync(stagedFramework, frameworkTarget); created.push(frameworkTarget);
  renameSync(stagedGovernance, governanceTarget); created.push(governanceTarget);
  renameSync(join(stage, "project-config.yaml"), configTarget); created.push(configTarget);
  mkdirSync(featureRootTarget, { recursive: true });
  if (!featureRootExisted) created.push(featureRootTarget);
  if (options.ci === "github") {
    mkdirSync(dirname(workflowTarget), { recursive: true });
    renameSync(join(stage, "workflow.yml"), workflowTarget); created.push(workflowTarget);
    renameSync(join(stage, "pull_request_template.md"), pullRequestTemplateTarget); created.push(pullRequestTemplateTarget);
  }
} catch (error) {
  for (const target of created.reverse()) rmSync(target, { recursive: true, force: true });
  fail(`安装未完成，已回滚新建目标：${error.message}`);
}

process.stdout.write(`Feature Delivery runtime installed.\nProject config: ${configTarget}\nFramework: ${frameworkTarget}\nGovernance: ${governanceTarget}\nPrimary branch: ${options.primaryBranch}\n\nNext:\n  (cd ${JSON.stringify(frameworkTarget)} && npm ci --ignore-scripts)\n  (cd ${JSON.stringify(frameworkTarget)} && npm test)\n  Review and commit this framework on the configured primary branch ${JSON.stringify(options.primaryBranch)} as a trusted baseline before enabling the required status check.\n  Register approval public keys through a separate governed change; no private key was created.\n`);
