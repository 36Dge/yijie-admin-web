import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

export const NEUTRAL_REPOSITORY_ID = "app";
export const DEFAULT_FRAMEWORK_ROOT = "platform/quality/feature-delivery/runtime";
export const DEFAULT_FEATURE_ROOT = "work-items/features";

export function run(command, args, options = {}) {
  const { env, ...rest } = options;
  return spawnSync(command, args, {
    encoding: "utf8",
    ...rest,
    env: { ...process.env, ...env },
  });
}

export function git(root, ...args) {
  const result = run("git", ["-C", root, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

export function writeYaml(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(value, { lineWidth: 0 }));
}

export function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"), { uniqueKeys: true });
}

export function projectConfig({
  projectId = "example-app",
  projectName = "Example App",
  repositoryId = NEUTRAL_REPOSITORY_ID,
  frameworkRoot = DEFAULT_FRAMEWORK_ROOT,
  featureRoot = DEFAULT_FEATURE_ROOT,
  governanceRoot = ".feature-delivery",
  repositoryRegistry = ".feature-delivery/repository-registry.yaml",
  ci = "none",
  requiredGate = "G3",
  actorId = "example.owner",
} = {}) {
  return {
    schema_version: 1,
    kind: "FeatureDeliveryProject",
    project: { id: projectId, display_name: projectName },
    paths: {
      framework_root: frameworkRoot,
      feature_root: featureRoot,
      governance_root: governanceRoot,
      repository_registry: repositoryRegistry,
    },
    repository: { current_id: repositoryId },
    defaults: { profile: "standard", delivery_target: "local_engineering", data_classification: "internal" },
    tooling: { package_manager: null, commands: { test: null, lint: null, build: null } },
    scm: { provider: "git", primary_branch: "main" },
    ci: { provider: ci, required_gate: requiredGate, status_context: "feature-delivery/trusted-coverage-status" },
    identity: { default_actor_id: actorId },
  };
}

export function repositoryRegistry({ repositoryId = NEUTRAL_REPOSITORY_ID, name = "example-app", url = "https://example.invalid/acme/example-app.git" } = {}) {
  return {
    schema_version: 1,
    kind: "FeatureDeliveryRepositoryRegistry",
    repositories: [
      { id: repositoryId, name, url, root: ".", kind: "current" },
      { id: "secondary", name: "secondary", url: "https://example.invalid/acme/secondary.git", root: "../secondary", kind: "external" },
      { id: "managed-lib", name: "managed-lib", url: "https://example.invalid/acme/managed-lib.git", root: "components/managed-lib", kind: "managed" },
    ],
  };
}

export function coveragePolicy({
  repositoryId = NEUTRAL_REPOSITORY_ID,
  featureRoot = DEFAULT_FEATURE_ROOT,
  frameworkRoot = DEFAULT_FRAMEWORK_ROOT,
  requiredGate = "G3",
  exemptions = [],
  protectedPaths = [],
} = {}) {
  return {
    schema_version: 1,
    kind: "FeatureChangeCoveragePolicy",
    repository_id: repositoryId,
    feature_root: featureRoot,
    required_gate: requiredGate,
    protected_paths: protectedPaths.length > 0 ? protectedPaths : [
      { path: ".feature-delivery.yaml", match: "exact", mode: "external_digest_only" },
      { path: ".feature-delivery", match: "prefix", mode: "external_digest_only" },
      { path: frameworkRoot, match: "prefix", mode: "external_digest_only" },
    ],
    exemptions,
  };
}

export function createProjectFixture(sourceFramework, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cfd-generic-project-")));
  const frameworkRoot = options.frameworkRoot ?? DEFAULT_FRAMEWORK_ROOT;
  const featureRoot = options.featureRoot ?? DEFAULT_FEATURE_ROOT;
  const repositoryId = options.repositoryId ?? NEUTRAL_REPOSITORY_ID;
  const governanceRoot = options.governanceRoot ?? ".feature-delivery";
  const frameworkDir = join(root, ...frameworkRoot.split("/"));
  const featureDir = join(root, ...featureRoot.split("/"));
  const governanceDir = join(root, ...governanceRoot.split("/"));

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Example Owner");
  git(root, "config", "user.email", "owner@example.invalid");
  git(root, "remote", "add", "origin", "https://example.invalid/acme/example-app.git");

  mkdirSync(dirname(frameworkDir), { recursive: true });
  mkdirSync(frameworkDir, { recursive: true });
  for (const entry of ["gate-policy.yaml", "package.json", "package-lock.json", "policies", "schemas", "scripts", "templates"]) {
    cpSync(resolve(sourceFramework, entry), join(frameworkDir, entry), { recursive: true });
  }
  symlinkSync(resolve(sourceFramework, "node_modules"), join(frameworkDir, "node_modules"), "dir");
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(governanceDir, { recursive: true });

  const configPath = join(root, ".feature-delivery.yaml");
  const registryPath = join(governanceDir, "repository-registry.yaml");
  const trustPath = join(governanceDir, "approval-trust.yaml");
  const policyPath = join(governanceDir, "change-coverage-policy.yaml");
  const legacyPath = join(governanceDir, "legacy-v1-allowlist.txt");
  writeYaml(configPath, projectConfig({
    frameworkRoot,
    featureRoot,
    governanceRoot,
    repositoryRegistry: `${governanceRoot}/repository-registry.yaml`,
    repositoryId,
    ci: options.ci ?? "none",
    requiredGate: options.requiredGate ?? "G3",
    actorId: options.actorId ?? "example.owner",
  }));
  writeYaml(registryPath, repositoryRegistry({ repositoryId }));
  writeYaml(trustPath, { schema_version: 1, kind: "FeatureDeliveryApprovalTrust", keys: [] });
  writeYaml(policyPath, coveragePolicy({ repositoryId, featureRoot, frameworkRoot, requiredGate: options.requiredGate ?? "G3" }));
  writeFileSync(legacyPath, "# Empty for a new generic project.\n");

  return {
    root,
    frameworkRoot,
    frameworkDir,
    featureRoot,
    featureDir,
    governanceRoot,
    governanceDir,
    repositoryId,
    configPath,
    registryPath,
    trustPath,
    policyPath,
    legacyPath,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
    scripts: {
      newFeature: join(frameworkDir, "scripts/new-feature.sh"),
      newFeatureMjs: join(frameworkDir, "scripts/new-feature.mjs"),
      evaluator: join(frameworkDir, "scripts/evaluate-feature-package.mjs"),
      checker: join(frameworkDir, "scripts/check-feature-package.sh"),
      checkAll: join(frameworkDir, "scripts/check-all-feature-packages.mjs"),
      checkChanged: join(frameworkDir, "scripts/check-changed-feature-coverage.mjs"),
      materializer: join(frameworkDir, "scripts/materialize-delivery-summary.mjs"),
      boundaryMaterializer: join(frameworkDir, "scripts/materialize-boundary.mjs"),
      signer: join(frameworkDir, "scripts/sign-decision.mjs"),
      initApproverKey: join(frameworkDir, "scripts/init-approver-key.mjs"),
    },
  };
}

export function assertNoInitResidue(root) {
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith(".cfd-init.tmp-")) : [];
}
