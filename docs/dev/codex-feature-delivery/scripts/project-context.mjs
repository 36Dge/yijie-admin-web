#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
export const PROJECT_CONFIG_NAME = ".feature-delivery.yaml";

function fail(message) {
  throw new Error(message);
}

export function gitRoot(startPath = process.cwd()) {
  const probe = spawnSync("git", ["-C", resolve(startPath), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout.trim()) fail(`无法从 ${resolve(startPath)} 发现 Git worktree 根`);
  return realpathSync(probe.stdout.trim());
}

export function safeProjectPath(value, label = "project path") {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)
      || value.split("/").some((part) => part === "." || part === ".." || part === "" || part === ".git")) {
    fail(`${label} 必须是安全的项目根相对 POSIX 路径：${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveProjectPath(repositoryRoot, value, label = "project path") {
  const normalized = safeProjectPath(value, label);
  const candidate = resolve(repositoryRoot, ...normalized.split("/"));
  const rel = relative(repositoryRoot, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} 越出项目根`);
  return candidate;
}

function readSafeFile(path, label) {
  if (!existsSync(path)) fail(`${label} 不存在：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(`${label} 必须是非 symlink/hardlink 的普通文件：${path}`);
  return readFileSync(path, "utf8");
}

export function parseYamlStrict(source, label) {
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) fail(`${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

function validator(schemaPath) {
  const schema = JSON.parse(readSafeFile(schemaPath, `Schema ${schemaPath}`));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function enforce(validate, value, label) {
  if (validate(value)) return;
  const details = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown schema error";
  fail(`${label} 不符合 Schema：${details}`);
}

export function discoverProjectConfig({ projectConfig = null, repositoryRoot = null, startPath = process.cwd() } = {}) {
  const exactRoot = (value) => {
    const root = gitRoot(value);
    if (realpathSync(resolve(value)) !== root) fail(`repository root 必须精确指向 Git worktree 根：${root}`);
    return root;
  };
  const explicit = projectConfig || process.env.CFD_PROJECT_CONFIG || null;
  if (explicit) {
    if (!existsSync(resolve(explicit))) fail(`项目配置不存在：${resolve(explicit)}`);
    const configPath = realpathSync(resolve(explicit));
    const root = repositoryRoot ? exactRoot(repositoryRoot) : gitRoot(dirname(configPath));
    if (configPath !== resolve(root, PROJECT_CONFIG_NAME)) fail(`项目配置必须位于 Git 根 ${PROJECT_CONFIG_NAME}：${configPath}`);
    return { repositoryRoot: root, configPath };
  }
  const root = repositoryRoot ? exactRoot(repositoryRoot) : gitRoot(startPath);
  return { repositoryRoot: root, configPath: resolve(root, PROJECT_CONFIG_NAME) };
}

export function loadProjectContext({
  projectConfig = null,
  repositoryRoot = null,
  startPath = process.cwd(),
  frameworkDir = DEFAULT_FRAMEWORK_DIR,
} = {}) {
  const discovered = discoverProjectConfig({ projectConfig, repositoryRoot, startPath });
  const canonicalFramework = realpathSync(resolve(frameworkDir));
  const configSource = readSafeFile(discovered.configPath, "项目配置");
  const preliminary = parseYamlStrict(configSource, discovered.configPath);
  const registryPath = resolveProjectPath(discovered.repositoryRoot, preliminary?.paths?.repository_registry, "paths.repository_registry");
  return loadProjectContextFromSources({
    configSource,
    registrySource: readSafeFile(registryPath, "repository registry"),
    configPath: discovered.configPath,
    repositoryRoot: discovered.repositoryRoot,
    frameworkDir: canonicalFramework,
  });
}

export function loadProjectContextFromSources({ configSource, registrySource, configPath, repositoryRoot, frameworkDir = DEFAULT_FRAMEWORK_DIR }) {
  const canonicalFramework = realpathSync(resolve(frameworkDir));
  const projectValidate = validator(resolve(canonicalFramework, "schemas/project-config.schema.json"));
  const registryValidate = validator(resolve(canonicalFramework, "schemas/repository-registry.schema.json"));
  const config = parseYamlStrict(configSource, configPath);
  enforce(projectValidate, config, "项目配置");
  const logicalRoots = [config.paths.framework_root, config.paths.feature_root, config.paths.governance_root];
  for (let left = 0; left < logicalRoots.length; left += 1) {
    for (let right = left + 1; right < logicalRoots.length; right += 1) {
      const a = safeProjectPath(logicalRoots[left], `paths root[${left}]`);
      const b = safeProjectPath(logicalRoots[right], `paths root[${right}]`);
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) fail("framework_root、feature_root、governance_root 必须互不重叠");
    }
  }
  const registryLogical = safeProjectPath(config.paths.repository_registry, "paths.repository_registry");
  const governanceLogical = safeProjectPath(config.paths.governance_root, "paths.governance_root");
  if (!registryLogical.startsWith(`${governanceLogical}/`)) fail("repository_registry 必须位于 governance_root 内");
  const paths = {};
  for (const [key, value] of Object.entries(config.paths)) paths[key] = resolveProjectPath(repositoryRoot, value, `paths.${key}`);
  if (!existsSync(paths.framework_root)) fail(`配置的 framework_root 不存在：${paths.framework_root}`);
  const frameworkMetadata = lstatSync(paths.framework_root);
  if (!frameworkMetadata.isDirectory() || frameworkMetadata.isSymbolicLink()) fail("framework_root 必须是非 symlink 目录");
  const configuredFramework = realpathSync(paths.framework_root);
  if (configuredFramework !== canonicalFramework) fail(`当前 runtime 路径 ${canonicalFramework} 与 config.paths.framework_root ${configuredFramework} 不一致`);
  const registry = parseYamlStrict(registrySource, paths.repository_registry);
  enforce(registryValidate, registry, "repository registry");
  const ids = registry.repositories.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail("repository registry 含重复 id");
  for (const [index, repository] of registry.repositories.entries()) {
    if (repository.kind === "current" && repository.root !== ".") fail(`registry.repositories[${index}] current root 必须是 .`);
    if (repository.kind === "managed") safeProjectPath(repository.root, `registry.repositories[${index}].root`);
    if (repository.kind === "external" && (!/^\.\.\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.root) || repository.root.slice(3) !== repository.name)) {
      fail(`registry.repositories[${index}] external root 只允许单层 ../<name> 且必须匹配 name`);
    }
  }
  const currentMatches = registry.repositories.filter((item) => item.kind === "current");
  if (currentMatches.length !== 1) fail("repository registry 必须恰好包含一个 kind=current repository");
  const currentRepository = currentMatches[0];
  if (currentRepository.id !== config.repository.current_id) fail("project.repository.current_id 与 registry current repository id 不一致");
  if (currentRepository.root !== ".") fail("registry current repository root 必须是 .");

  const governance = {
    trustRoot: resolve(paths.governance_root, "approval-trust.yaml"),
    changeCoveragePolicy: resolve(paths.governance_root, "change-coverage-policy.yaml"),
    legacyAllowlist: resolve(paths.governance_root, "legacy-v1-allowlist.txt"),
  };
  return {
    config,
    configPath,
    repositoryRoot,
    frameworkRoot: configuredFramework,
    featureRoot: paths.feature_root,
    governanceRoot: paths.governance_root,
    registryPath: paths.repository_registry,
    registry,
    currentRepository,
    governance,
  };
}

export function projectContextArgs(argv) {
  let projectConfig = null;
  let repositoryRoot = null;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-config" || arg === "--repository-root") {
      const value = argv[++index];
      if (!value) fail(`${arg} 缺少值`);
      if (arg === "--project-config") projectConfig = value;
      else repositoryRoot = value;
    } else if (arg.startsWith("--project-config=")) projectConfig = arg.slice("--project-config=".length);
    else if (arg.startsWith("--repository-root=")) repositoryRoot = arg.slice("--repository-root=".length);
    else rest.push(arg);
  }
  return { projectConfig, repositoryRoot, rest };
}

export function main(argv = process.argv.slice(2)) {
  const { projectConfig, repositoryRoot, rest } = projectContextArgs(argv);
  if (rest.length > 0) fail(`未知参数：${rest.join(" ")}`);
  const context = loadProjectContext({ projectConfig, repositoryRoot });
  process.stdout.write(`${JSON.stringify({
    project_config: context.configPath,
    repository_root: context.repositoryRoot,
    framework_root: context.frameworkRoot,
    feature_root: context.featureRoot,
    governance_root: context.governanceRoot,
    repository_registry: context.registryPath,
    current_repository: context.currentRepository,
  }, null, 2)}\n`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`project-context: ${error.message}\n`);
    process.exitCode = 1;
  }
}
