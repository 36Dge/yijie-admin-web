#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadLegacyPins } from "./legacy-v1.mjs";
import { loadProjectContext } from "./project-context.mjs";
import { validateApprovalTrustRoot } from "./approval-attestation.mjs";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
const EVALUATOR = resolve(SCRIPT_DIR, "evaluate-feature-package.mjs");
const options = { projectConfig: null, repositoryRoot: null, featureRootAssertion: null, trustRoot: null };

function usage(code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: check-all-feature-packages.mjs [options]

Options:
  --project-config FILE  Project-root .feature-delivery.yaml; otherwise discovery/env is used.
  --repository-root DIR  Assert the exact Git worktree root.
  --feature-root DIR     Assert the configured Feature root; cannot override it.
  --trust-root FILE      Explicit trust root; default: configured project governance trust root.
  -h, --help
`);
  process.exit(code);
}

function canonicalExistingDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} 必须是非 symlink 目录：${path}`);
  return realpathSync(path);
}
const args = process.argv.slice(2);
try {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = () => { const value = args[++index]; if (!value) throw new Error(`${arg} 缺少值`); return value; };
    if (arg === "-h" || arg === "--help") usage(0);
    else if (arg === "--project-config") options.projectConfig = take();
    else if (arg === "--repository-root") options.repositoryRoot = take();
    else if (arg === "--feature-root") options.featureRootAssertion = resolve(take());
    else if (arg === "--trust-root") options.trustRoot = resolve(take());
    else throw new Error(`未知参数：${arg}`);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(2);
}

let context;
try { context = loadProjectContext({ projectConfig: options.projectConfig, repositoryRoot: options.repositoryRoot, frameworkDir: FRAMEWORK_DIR }); }
catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(2); }
let featureRoot;
try {
  featureRoot = canonicalExistingDirectory(context.featureRoot, "Feature root");
  if (options.featureRootAssertion) {
    const assertedFeatureRoot = canonicalExistingDirectory(options.featureRootAssertion, "--feature-root");
    if (assertedFeatureRoot !== featureRoot) throw new Error(`--feature-root 与项目配置不一致：${assertedFeatureRoot} != ${featureRoot}`);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(2);
}
const trustRoot = options.trustRoot ?? context.governance.trustRoot;
let legacyPins;
try { legacyPins = loadLegacyPins(context.governance.legacyAllowlist); }
catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(2); }
const errors = [];
try {
  const policyMetadata = lstatSync(context.governance.changeCoveragePolicy);
  if (!policyMetadata.isFile() || policyMetadata.isSymbolicLink() || policyMetadata.nlink !== 1) throw new Error("change coverage policy 必须是非 symlink/hardlink 的普通文件");
  const policyDocument = YAML.parseDocument(readFileSync(context.governance.changeCoveragePolicy, "utf8"), { uniqueKeys: true, prettyErrors: true });
  if (policyDocument.errors.length) throw new Error(policyDocument.errors.map((item) => item.message).join("; "));
  const policy = policyDocument.toJS();
  const schema = JSON.parse(readFileSync(resolve(FRAMEWORK_DIR, "schemas/change-coverage-policy.schema.json"), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } }).compile(schema);
  if (!validate(policy)) throw new Error(validate.errors.map((item) => `${item.instancePath || "/"} ${item.message}`).join("; "));
  if (policy.repository_id !== context.currentRepository.id || policy.feature_root !== context.config.paths.feature_root || policy.required_gate !== context.config.ci.required_gate) {
    throw new Error("change coverage policy 与 project config 的 repository/feature_root/required_gate 不一致");
  }
} catch (error) {
  errors.push(`change coverage policy 无效：${error.message}`);
}
try {
  const trustMetadata = lstatSync(trustRoot);
  if (!trustMetadata.isFile() || trustMetadata.isSymbolicLink() || trustMetadata.nlink !== 1) throw new Error("approval trust root 必须是非 symlink/hardlink 的普通文件");
  const trustDocument = YAML.parseDocument(readFileSync(trustRoot, "utf8"), { uniqueKeys: true, prettyErrors: true });
  if (trustDocument.errors.length) throw new Error(trustDocument.errors.map((item) => item.message).join("; "));
  const trustErrors = validateApprovalTrustRoot(trustDocument.toJS());
  if (trustErrors.length) throw new Error(trustErrors.join("; "));
} catch (error) {
  errors.push(`approval trust root 无效：${error.message}`);
}
let v2Count = 0;
let legacyCount = 0;
const featureIds = new Map();
for (const name of readdirSync(featureRoot).sort()) {
  const packageDir = resolve(featureRoot, name);
  const metadata = lstatSync(packageDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !existsSync(resolve(packageDir, "feature.yaml"))) continue;
  const evaluation = spawnSync(process.execPath, [EVALUATOR, "--project-config", context.configPath, "--repository-root", context.repositoryRoot, "--trust-root", trustRoot, "--allow-legacy", "--json", packageDir], { encoding: "utf8" });
  let report;
  try { report = JSON.parse(evaluation.stdout); }
  catch { errors.push(`${name}: evaluator 未返回 JSON：${evaluation.stderr || evaluation.stdout}`); continue; }
  if (report.legacy) {
    legacyCount += 1;
    const expected = legacyPins.get(name) ?? null;
    const exact = evaluation.status !== 0 && report.valid === false && report.recognized === true && report.verdict === "LEGACY_RECOGNIZED" && report.expected_tree_digest === expected && report.tree_digest === expected;
    if (!exact) errors.push(`${name}: legacy v1 未通过精确只读 pin`);
    continue;
  }
  v2Count += 1;
  const id = report.feature?.id;
  if (id && featureIds.has(id)) errors.push(`重复 feature.id=${id}：${featureIds.get(id)} 与 ${name}`);
  else if (id) featureIds.set(id, name);
  if (evaluation.status !== 0 || !report.valid) errors.push(`${name}: ${report.errors?.join("; ") || "v2 校验失败"}`);
}
for (const name of legacyPins.keys()) if (!existsSync(resolve(featureRoot, name, "feature.yaml"))) errors.push(`legacy allowlist 指向不存在的包：${name}`);
if (errors.length) { for (const error of errors) process.stderr.write(`ERROR: ${error}\n`); process.exit(1); }
process.stdout.write(`Feature Packages valid: v2=${v2Count}, legacy_recognized=${legacyCount} (legacy is not Gate PASS)\n`);
