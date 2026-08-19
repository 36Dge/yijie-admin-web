#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { loadProjectContext } from "./project-context.mjs";
import { loadActiveGatePolicy } from "./policy-registry.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
const TEMPLATE_DIR = resolve(FRAMEWORK_DIR, "templates/feature-package");

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function usage(code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: new-feature.sh FEAT-ID slug --scope REPO_PATH [options]

Options:
  --project-config FILE
  --profile lite|standard|controlled
  --target local_engineering|staging|production
  --title TITLE
  --owner ACTOR_ID
  --scope REPO_PATH          required; safe repository-relative scope
  --allow-root-scope         required when --scope .
  --root-scope-justification TEXT
                             required with --scope .; forbidden otherwise
  -h, --help
`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) usage(0);
if (args.length < 2) usage(2);
const featureId = args.shift();
const slug = args.shift();
const options = { projectConfig: null, profile: null, target: null, title: slug.replaceAll("-", " "), owner: null, scope: null, allowRootScope: false, rootScopeJustification: null };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const take = () => {
    const value = args[++index];
    if (!value) fail(`${arg} 缺少值`, 2);
    return value;
  };
  if (arg === "--project-config") options.projectConfig = take();
  else if (arg === "--profile") options.profile = take();
  else if (arg === "--target") options.target = take();
  else if (arg === "--title") options.title = take();
  else if (arg === "--owner") options.owner = take();
  else if (arg === "--scope") options.scope = take();
  else if (arg === "--allow-root-scope") options.allowRootScope = true;
  else if (arg === "--root-scope-justification") options.rootScopeJustification = take();
  else fail(`未知参数：${arg}`, 2);
}
if (!/^FEAT-[A-Z0-9][A-Z0-9.-]*$/.test(featureId)) fail("FEAT-ID 必须符合 FEAT-*，并使用大写标识", 2);
if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) fail("slug 格式无效", 2);
if (!options.scope) fail("--scope 必填；必须在创建 Package 时给出最小实现范围", 2);
if (options.scope === "." && !options.allowRootScope) fail("--scope . 必须同时显式 --allow-root-scope", 2);
if (options.scope === "." && !options.rootScopeJustification) fail("--scope . 必须提供真实的 --root-scope-justification", 2);
if (options.scope !== "." && (options.allowRootScope || options.rootScopeJustification)) fail("--allow-root-scope/--root-scope-justification 只允许与 --scope . 一起使用", 2);
if (options.rootScopeJustification && (!options.rootScopeJustification.trim() || options.rootScopeJustification.includes("{{"))) fail("root scope justification 必须是非空真实理由，且不能包含保留模板边界 {{", 2);
if (options.scope !== "." && (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(options.scope) || options.scope.split("/").some((part) => part === "." || part === ".." || part === "" || part === ".git"))) fail("--scope 必须是单一规范表示的安全 repo-relative path，且不能进入 .git", 2);

let context;
try { context = loadProjectContext({ projectConfig: options.projectConfig, startPath: process.cwd(), frameworkDir: FRAMEWORK_DIR }); }
catch (error) { fail(error.message, 2); }
const profile = options.profile ?? context.config.defaults.profile;
const deliveryTarget = options.target ?? context.config.defaults.delivery_target;
const owner = options.owner ?? context.config.identity.default_actor_id;
if (!["lite", "standard", "controlled"].includes(profile)) fail(`无效 profile：${profile}`, 2);
if (!["local_engineering", "staging", "production"].includes(deliveryTarget)) fail(`无效 target：${deliveryTarget}`, 2);
for (const [label, value] of [["title", options.title], ["owner", owner]]) if (!value || /[\r\n]/.test(value) || value.includes("{{")) fail(`${label} 无效`, 2);

const targetDir = resolve(context.featureRoot, `${featureId}-${slug}`);
if (existsSync(targetDir)) fail(`目标已存在，不会覆盖：${targetDir}`);
mkdirSync(context.featureRoot, { recursive: true });
const stagingDir = mkdtempSync(resolve(context.featureRoot, `${featureId}-${slug}.tmp-`));
let published = false;
process.once("exit", () => { if (!published) rmSync(stagingDir, { recursive: true, force: true }); });

const mandatory = ["feature.yaml", "evidence.yaml", "decisions.yaml", "00-feature-brief.md", "01-requirements.md", "02-impact-assessment.md", "06-test-plan.md", "07-implementation-plan.md", "08-verification-report.md"];
for (const name of mandatory) cpSync(resolve(TEMPLATE_DIR, name), resolve(stagingDir, name));
const artifactSettings = {
  "ART-DECISIONS": profile === "lite" ? ["not_applicable", "lite_profile"] : ["required", `profile_${profile}`],
  "ART-CONTRACT": profile === "lite" ? ["not_applicable", "lite_profile"] : ["conditional", "materialize_when_boundary_declared"],
  "ART-DESIGN": profile === "lite" ? ["not_applicable", "lite_profile"] : ["required", `profile_${profile}`],
  "ART-RELEASE": deliveryTarget === "local_engineering" ? ["not_applicable", "local_engineering_target"] : ["required", `target_${deliveryTarget}`],
};
if (profile !== "lite") for (const name of ["03-decisions-and-risks.md", "05-technical-design.md"]) cpSync(resolve(TEMPLATE_DIR, name), resolve(stagingDir, name));
if (deliveryTarget !== "local_engineering") cpSync(resolve(TEMPLATE_DIR, "09-release-and-rollback.md"), resolve(stagingDir, "09-release-and-rollback.md"));

const active = loadActiveGatePolicy(FRAMEWORK_DIR);
const today = new Date().toISOString().slice(0, 10);
const replacements = {
  FEATURE_ID: featureId, FEATURE_SLUG: slug, TITLE: options.title, OWNER: owner, OWNER_ID: owner,
  PROFILE: profile, DELIVERY_TARGET: deliveryTarget, DATE: today,
  REPOSITORY_IDENTITY: context.currentRepository.url, REPOSITORY_NAME: context.currentRepository.name,
  CURRENT_REPOSITORY_ID: context.currentRepository.id, REPOSITORY_ID: context.currentRepository.id,
  REPOSITORY_SCOPE: options.scope,
  ROOT_SCOPE_JUSTIFICATION: options.rootScopeJustification ?? "not_applicable",
  DATA_CLASSIFICATION: context.config.defaults.data_classification,
  TEST_COMMAND: context.config.tooling.commands.test ?? "not_configured",
  PACKAGE_MANAGER: context.config.tooling.package_manager ?? "not_configured",
  TOOL_VERSION: process.version,
  POLICY_ID: active.data.policy.id, POLICY_VERSION: active.data.policy.version, POLICY_DIGEST: active.digest,
};
function replaceTokens(source) {
  let result = source;
  for (const [key, value] of Object.entries(replacements)) result = result.replaceAll(`{{${key}}}`, () => String(value));
  return result;
}
function yamlDocument(name) {
  const path = resolve(stagingDir, name);
  const document = YAML.parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length) fail(`${name}: ${document.errors.map((error) => error.message).join("; ")}`);
  return { path, document };
}
const { path: manifestPath, document: manifest } = yamlDocument("feature.yaml");
manifest.setIn(["policy", "id"], replacements.POLICY_ID);
manifest.setIn(["policy", "version"], replacements.POLICY_VERSION);
manifest.setIn(["policy", "digest"], replacements.POLICY_DIGEST);
for (const [key, value] of Object.entries({ id: featureId, slug, title: options.title, summary: options.title, profile, delivery_target: deliveryTarget, created_at: today, updated_at: today })) manifest.setIn(["feature", key], value);
manifest.setIn(["feature", "owners", "accountable"], owner);
manifest.setIn(["feature", "owners", "role_assignments", 0, "actor"], owner);
manifest.setIn(["classification", "data"], context.config.defaults.data_classification);
manifest.setIn(["repositories", 0, "id"], context.currentRepository.id);
for (const [key, value] of Object.entries({ kind: "current", name: context.currentRepository.name, url: context.currentRepository.url, root: "." })) manifest.setIn(["repositories", 0, "identity", key], value);
manifest.setIn(["repositories", 0, "path"], options.scope);
manifest.setIn(["repositories", 0, "root_scope_justification"], options.scope === "." ? options.rootScopeJustification : null);
manifest.setIn(["repositories", 0, "root_scope_exception_evidence_id"], null);
manifest.setIn(["slices", 0, "repositories"], [context.currentRepository.id]);
manifest.setIn(["slices", 0, "paths"], [{ repository: context.currentRepository.id, path: options.scope }]);
manifest.setIn(["acceptance_criteria", 0, "statement"], `${options.title} 的最小可验证结果`);
const artifacts = manifest.get("artifacts", true)?.items ?? [];
for (let index = 0; index < artifacts.length; index += 1) {
  const setting = artifactSettings[manifest.getIn(["artifacts", index, "id"])];
  if (!setting) continue;
  manifest.setIn(["artifacts", index, "applicability"], setting[0]);
  manifest.setIn(["artifacts", index, "reason"], setting[1]);
}
writeFileSync(manifestPath, replaceTokens(manifest.toString({ lineWidth: 0 })));
for (const name of ["evidence.yaml", "decisions.yaml"]) {
  const { path, document } = yamlDocument(name);
  document.set("feature_id", featureId);
  writeFileSync(path, replaceTokens(document.toString({ lineWidth: 0 })));
}
for (const name of readdirSync(stagingDir)) if (name.endsWith(".md")) writeFileSync(resolve(stagingDir, name), replaceTokens(readFileSync(resolve(stagingDir, name), "utf8")));

const evaluation = spawnSync(process.execPath, [resolve(SCRIPT_DIR, "evaluate-feature-package.mjs"), "--project-config", context.configPath, "--repository-root", context.repositoryRoot, stagingDir], { encoding: "utf8", env: process.env });
if (evaluation.status !== 0) fail(`生成结果未通过校验：${evaluation.stderr || evaluation.stdout}`);
if (existsSync(targetDir)) fail(`目标在生成期间出现，不会覆盖：${targetDir}`);
renameSync(stagingDir, targetDir);
published = true;
process.stdout.write(`Created Feature Package v2:\n  ${targetDir}\n  repository=${context.currentRepository.id} scope=${options.scope} profile=${profile} target=${deliveryTarget}\n`);
