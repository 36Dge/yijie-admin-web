import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import {
  assertNoInitResidue,
  createProjectFixture,
  git,
  readYaml,
  run,
  writeYaml,
} from "./project-fixture.mjs";

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const initProject = join(distributionRoot, "scripts/init-project.mjs");

function freshRepository(t, prefix = "cfd-new-project-", branch = "main") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", branch);
  git(root, "config", "user.name", "Example Owner");
  git(root, "config", "user.email", "owner@example.invalid");
  git(root, "remote", "add", "origin", "https://example.invalid/acme/greenfield.git");
  return root;
}

function initArgs(root, overrides = {}) {
  const args = [
    initProject,
    "--project-root", root,
    "--project-id", overrides.projectId ?? "greenfield",
    "--project-name", overrides.projectName ?? "Greenfield Product",
    "--repository-id", overrides.repositoryId ?? "app",
    "--actor-id", overrides.actorId ?? "alex.owner",
    "--framework-root", overrides.frameworkRoot ?? "ops/platform/deep/feature-delivery-runtime",
    "--feature-root", overrides.featureRoot ?? "product/feature-packages",
    "--ci", overrides.ci ?? "none",
  ];
  if (Object.hasOwn(overrides, "primaryBranch")) args.push("--primary-branch", overrides.primaryBranch);
  return args;
}

function initialize(t, overrides = {}) {
  const root = freshRepository(t);
  const args = initArgs(root, overrides);
  const result = run(process.execPath, args);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const frameworkRoot = overrides.frameworkRoot ?? "ops/platform/deep/feature-delivery-runtime";
  const featureRoot = overrides.featureRoot ?? "product/feature-packages";
  return {
    root,
    result,
    frameworkRoot,
    featureRoot,
    frameworkDir: join(root, ...frameworkRoot.split("/")),
    featureDir: join(root, ...featureRoot.split("/")),
    configPath: join(root, ".feature-delivery.yaml"),
    governanceDir: join(root, ".feature-delivery"),
  };
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageTempEntries(featureDir, prefix) {
  return existsSync(featureDir) ? readdirSync(featureDir).filter((name) => name.startsWith(`${prefix}.tmp-`)) : [];
}

test("init installs the generic runtime into a package-less project and survives repository rename", (t) => {
  const state = initialize(t, { ci: "none" });
  assert.equal(existsSync(join(state.root, "package.json")), false, "the host project need not be a Node project");
  assert.equal(existsSync(join(state.root, ".github/workflows/feature-delivery-coverage.yml")), false);
  assert.equal(assertNoInitResidue(state.root).length, 0);
  assert.ok((lstatSync(join(state.frameworkDir, "scripts/new-feature.sh")).mode & 0o111) !== 0, "installer preserves executable mode");

  const installed = run("npm", ["ci", "--ignore-scripts"], { cwd: state.frameworkDir });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  const title = String.raw`Literal $& and backslash \\ stay data`;
  const generated = run(join(state.frameworkDir, "scripts/new-feature.sh"), [
    "FEAT-GREENFIELD-001", "safe-title", "--scope", "src/app", "--title", title,
  ], { cwd: state.root });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const packageDir = join(state.featureDir, "FEAT-GREENFIELD-001-safe-title");
  const manifest = readYaml(join(packageDir, "feature.yaml"));
  assert.equal(manifest.feature.title, title);
  assert.equal(manifest.repositories[0].id, "app");
  assert.equal(manifest.repositories[0].identity.kind, "current");
  assert.equal(manifest.repositories[0].identity.url, "https://example.invalid/acme/greenfield.git");
  assert.equal(manifest.repositories[0].path, "src/app");
  assert.deepEqual(manifest.slices[0].repositories, ["app"]);
  assert.deepEqual(manifest.slices[0].paths, [{ repository: "app", path: "src/app" }]);

  const evaluated = run(process.execPath, [join(state.frameworkDir, "scripts/evaluate-feature-package.mjs"), "--json", packageDir]);
  assert.equal(evaluated.status, 0, `${evaluated.stdout}\n${evaluated.stderr}`);
  assert.equal(JSON.parse(evaluated.stdout).verdict, "VALID");
  const checked = run(process.execPath, [join(state.frameworkDir, "scripts/check-all-feature-packages.mjs"), "--repository-root", state.root]);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /v2=1/);

  const renamedRoot = join(dirname(state.root), `${state.root.split("/").at(-1)}-renamed`);
  renameSync(state.root, renamedRoot);
  t.after(() => rmSync(renamedRoot, { recursive: true, force: true }));
  const renamedFramework = join(renamedRoot, ...state.frameworkRoot.split("/"));
  const renamedPackage = join(renamedRoot, ...state.featureRoot.split("/"), "FEAT-GREENFIELD-001-safe-title");
  const afterRename = run(process.execPath, [join(renamedFramework, "scripts/evaluate-feature-package.mjs"), "--json", renamedPackage]);
  assert.equal(afterRename.status, 0, `${afterRename.stdout}\n${afterRename.stderr}`);
  assert.equal(JSON.parse(afterRename.stdout).feature.id, "FEAT-GREENFIELD-001");
});

test("GitHub installation renders a base-trusted workflow without candidate execution", (t) => {
  const state = initialize(t, { ci: "github", frameworkRoot: "governance/runtime/custom-name", featureRoot: "delivery/features" });
  const workflow = readFileSync(join(state.root, ".github/workflows/feature-delivery-coverage.yml"), "utf8");
  assert.doesNotMatch(workflow, /__[A-Z0-9_]+__/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /types:\s*\[[^\]]*edited[^\]]*\]/);
  assert.match(workflow, /environment:\s*feature-delivery-trusted/);
  assert.match(workflow, /CFD_FRAMEWORK_ROOT:\s*governance\/runtime\/custom-name/);
  assert.match(workflow, /CFD_FEATURE_ROOT:\s*delivery\/features/);
  assert.match(workflow, /CFD_REPOSITORY_ID:\s*app/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /test "\$actual_base_sha" = "\$EXPECTED_BASE_SHA"/);
  assert.match(workflow, /test "\$actual_head_sha" = "\$EXPECTED_HEAD_SHA"/);
  assert.doesNotMatch(workflow, /checkout[^\n]*head\.sha/i);
  assert.doesNotMatch(workflow, /node[^\n]*(?:head\.sha|refs\/remotes\/pull\/candidate)/i);
  assert.match(workflow, /\(cd "\$CFD_FRAMEWORK_ROOT" && npm ci --ignore-scripts\)/);
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(workflow, /permission-statuses:\s*write/);
  assert.doesNotMatch(workflow, /^\s*statuses:\s*write\s*$/m);
  assert.match(workflow, /-f state=pending/);
  assert.equal((workflow.match(/^\s+HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/gm) ?? []).length, 2);
  assert.equal((workflow.match(/context="feature-delivery\/trusted-coverage-status"/g) ?? []).length, 2);
  assert.match(workflow, /if:\s*\$\{\{ always\(\).*status_token\.outcome == 'success'/);
});

test("init discovers the attached primary branch and supports an explicit stable override", async (t) => {
  await t.test("discovers trunk", (t) => {
    const root = freshRepository(t, "cfd-trunk-project-", "trunk");
    const result = run(process.execPath, initArgs(root));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readYaml(join(root, ".feature-delivery.yaml")).scm.primary_branch, "trunk");
  });

  await t.test("explicit release/v1 overrides the attached branch", (t) => {
    const root = freshRepository(t, "cfd-release-project-", "trunk");
    const result = run(process.execPath, initArgs(root, { primaryBranch: "release/v1" }));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readYaml(join(root, ".feature-delivery.yaml")).scm.primary_branch, "release/v1");
  });
});

test("detached HEAD requires an explicit primary branch and init remains atomic", (t) => {
  const root = freshRepository(t, "cfd-detached-project-", "trunk");
  writeFileSync(join(root, "README.md"), "detached fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "fixture commit");
  git(root, "checkout", "-q", "--detach", "HEAD");

  const implicit = run(process.execPath, initArgs(root));
  assert.equal(implicit.status, 2, `${implicit.stdout}\n${implicit.stderr}`);
  assert.match(`${implicit.stdout}\n${implicit.stderr}`, /detached|primary-branch|主分支/i);
  assert.equal(existsSync(join(root, ".feature-delivery.yaml")), false);
  assert.equal(existsSync(join(root, ".feature-delivery")), false);
  assert.equal(assertNoInitResidue(root).length, 0);

  const explicit = run(process.execPath, initArgs(root, { primaryBranch: "trunk" }));
  assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`);
  assert.equal(readYaml(join(root, ".feature-delivery.yaml")).scm.primary_branch, "trunk");
});

test("init rejects non-canonical primary branch values without residue", async (t) => {
  for (const branch of ["bad..name", "refs/heads/main", "main lock", ".", "main~1"]) {
    await t.test(branch, (t) => {
      const root = freshRepository(t, "cfd-invalid-branch-", "trunk");
      const result = run(process.execPath, initArgs(root, { primaryBranch: branch }));
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /primary-branch|branch|分支/i);
      assert.equal(existsSync(join(root, ".feature-delivery.yaml")), false);
      assert.equal(existsSync(join(root, ".feature-delivery")), false);
      assert.equal(assertNoInitResidue(root).length, 0);
    });
  }
});

test("check-all help is available without a project context", () => {
  const result = run(process.execPath, [join(distributionRoot, "scripts/check-all-feature-packages.mjs"), "--help"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Usage:|用法/i);
  assert.match(result.stdout, /--project-config/);
});

test("init rejects unsafe or overlapping roots before writing any delivery state", async (t) => {
  const cases = [
    { name: "dot segment", frameworkRoot: "foo/./bar" },
    { name: "git segment", frameworkRoot: "foo/.git/bar" },
    { name: "same roots", frameworkRoot: "product/features", featureRoot: "product/features" },
    { name: "nested roots", frameworkRoot: "product", featureRoot: "product/features" },
    { name: "framework in governance", frameworkRoot: ".feature-delivery/runtime" },
    { name: "feature in governance", featureRoot: ".feature-delivery/features" },
  ];
  for (const item of cases) {
    await t.test(item.name, (t) => {
      const root = freshRepository(t, "cfd-unsafe-init-");
      const result = run(process.execPath, initArgs(root, item));
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(join(root, ".feature-delivery.yaml")), false);
      assert.equal(existsSync(join(root, ".feature-delivery")), false);
      assert.equal(assertNoInitResidue(root).length, 0);
    });
  }
});

test("repeated or colliding init never overwrites an installed baseline and leaves no staging residue", (t) => {
  const state = initialize(t, { ci: "github" });
  const configDigest = digest(state.configPath);
  const readmePath = join(state.frameworkDir, "README.md");
  const originalReadme = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, `${originalReadme}\nLOCAL SENTINEL\n`);
  const repeated = run(process.execPath, initArgs(state.root, { ci: "github" }));
  assert.notEqual(repeated.status, 0);
  assert.match(`${repeated.stdout}\n${repeated.stderr}`, /目标已存在|不会覆盖/);
  assert.equal(digest(state.configPath), configDigest);
  assert.match(readFileSync(readmePath, "utf8"), /LOCAL SENTINEL/);
  assert.equal(assertNoInitResidue(state.root).length, 0);

  const collisionRoot = freshRepository(t, "cfd-init-collision-");
  mkdirSync(join(collisionRoot, ".github/workflows"), { recursive: true });
  const collisionPath = join(collisionRoot, ".github/workflows/feature-delivery-coverage.yml");
  writeFileSync(collisionPath, "user-owned workflow\n");
  const collision = run(process.execPath, initArgs(collisionRoot, { ci: "github" }));
  assert.notEqual(collision.status, 0);
  assert.equal(readFileSync(collisionPath, "utf8"), "user-owned workflow\n");
  assert.equal(existsSync(join(collisionRoot, ".feature-delivery.yaml")), false);
  assert.equal(existsSync(join(collisionRoot, ".feature-delivery")), false);
  assert.equal(assertNoInitResidue(collisionRoot).length, 0);
});

test("project context rejects missing config, duplicate identity facts, unsafe registry roots, and path overlap", async (t) => {
  await t.test("missing config", (t) => {
    const root = freshRepository(t, "cfd-missing-config-");
    const result = run(join(distributionRoot, "scripts/new-feature.sh"), ["FEAT-NO-CONFIG", "missing", "--scope", "src/app"], { cwd: root });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /项目配置|\.feature-delivery\.yaml|不存在/i);
  });

  const mutations = [
    {
      name: "repository id double fact",
      mutate(fixture) {
        const registry = readYaml(fixture.registryPath);
        registry.repositories[0].id = "spoofed-app";
        writeYaml(fixture.registryPath, registry);
      },
      pattern: /current_id|current repository id|不一致/i,
    },
    {
      name: "managed root traversal",
      mutate(fixture) {
        const registry = readYaml(fixture.registryPath);
        registry.repositories.find((item) => item.id === "managed-lib").root = "../escape";
        writeYaml(fixture.registryPath, registry);
      },
      pattern: /repository registry|pattern|安全.*路径/i,
    },
    {
      name: "external root spoof",
      mutate(fixture) {
        const registry = readYaml(fixture.registryPath);
        registry.repositories.find((item) => item.id === "secondary").root = "../different-name";
        writeYaml(fixture.registryPath, registry);
      },
      pattern: /external root|匹配 name/i,
    },
    {
      name: "dot segment in config",
      mutate(fixture) {
        const config = readYaml(fixture.configPath);
        config.paths.feature_root = "foo/./bar";
        writeYaml(fixture.configPath, config);
      },
      pattern: /Schema|projectPath|pattern|安全/i,
    },
    {
      name: "git segment in config",
      mutate(fixture) {
        const config = readYaml(fixture.configPath);
        config.paths.feature_root = "foo/.git/bar";
        writeYaml(fixture.configPath, config);
      },
      pattern: /Schema|projectPath|pattern|安全/i,
    },
    {
      name: "framework feature overlap",
      mutate(fixture) {
        const config = readYaml(fixture.configPath);
        config.paths.feature_root = `${config.paths.framework_root}/features`;
        writeYaml(fixture.configPath, config);
      },
      pattern: /互不重叠/i,
    },
    {
      name: "registry outside governance",
      mutate(fixture) {
        const config = readYaml(fixture.configPath);
        config.paths.repository_registry = "config/repositories.yaml";
        writeYaml(fixture.configPath, config);
        mkdirSync(join(fixture.root, "config"), { recursive: true });
        cpSync(fixture.registryPath, join(fixture.root, "config/repositories.yaml"));
      },
      pattern: /repository_registry.*governance_root/i,
    },
  ];
  for (const item of mutations) {
    await t.test(item.name, (t) => {
      const fixture = createProjectFixture(distributionRoot);
      t.after(() => fixture.cleanup());
      item.mutate(fixture);
      const result = run(process.execPath, [join(fixture.frameworkDir, "scripts/project-context.mjs"), "--repository-root", fixture.root]);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, item.pattern);
    });
  }
});

test("generator enforces explicit minimal scope, root-scope justification, safe text, and atomic publication", async (t) => {
  const fixture = createProjectFixture(distributionRoot);
  t.after(() => fixture.cleanup());
  const generator = fixture.scripts.newFeature;
  const cases = [
    { name: "missing scope", args: ["FEAT-SCOPE-001", "missing"], pattern: /--scope 必填/ },
    { name: "root without opt-in", args: ["FEAT-SCOPE-002", "root", "--scope", "."], pattern: /--allow-root-scope/ },
    { name: "root without reason", args: ["FEAT-SCOPE-003", "root", "--scope", ".", "--allow-root-scope"], pattern: /justification/ },
    { name: "blank root reason", args: ["FEAT-SCOPE-004", "root", "--scope", ".", "--allow-root-scope", "--root-scope-justification", "   "], pattern: /真实理由/ },
    { name: "reason on non-root", args: ["FEAT-SCOPE-005", "reason", "--scope", "src/app", "--root-scope-justification", "not root"], pattern: /只允许与 --scope \./ },
    { name: "dot segment", args: ["FEAT-SCOPE-006", "dot", "--scope", "src/./app"], pattern: /安全 repo-relative|规范表示/ },
    { name: "git path", args: ["FEAT-SCOPE-007", "git", "--scope", ".git/hooks"], pattern: /\.git|安全 repo-relative/ },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const result = run(generator, item.args, { cwd: fixture.root });
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, item.pattern);
      assert.equal(packageTempEntries(fixture.featureDir, `${item.args[0]}-${item.args[1]}`).length, 0);
    });
  }

  const title = String.raw`Replacement tokens $& $1 and C:\\work\\item`;
  const first = run(generator, ["FEAT-SCOPE-008", "safe-text", "--scope", "src/app", "--title", title], { cwd: fixture.root });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const packageDir = join(fixture.featureDir, "FEAT-SCOPE-008-safe-text");
  assert.equal(readYaml(join(packageDir, "feature.yaml")).feature.title, title);
  const briefPath = join(packageDir, "00-feature-brief.md");
  writeFileSync(briefPath, `${readFileSync(briefPath, "utf8")}\nUSER SENTINEL\n`);
  const duplicate = run(generator, ["FEAT-SCOPE-008", "safe-text", "--scope", "src/app", "--title", "overwrite attempt"], { cwd: fixture.root });
  assert.notEqual(duplicate.status, 0);
  assert.match(readFileSync(briefPath, "utf8"), /USER SENTINEL/);
  assert.equal(packageTempEntries(fixture.featureDir, "FEAT-SCOPE-008-safe-text").length, 0);

  const wholeRoot = run(generator, [
    "FEAT-SCOPE-009", "whole-root", "--scope", ".", "--allow-root-scope",
    "--root-scope-justification", "Repository-wide build-system migration requires an indivisible baseline",
  ], { cwd: fixture.root });
  assert.equal(wholeRoot.status, 0, `${wholeRoot.stdout}\n${wholeRoot.stderr}`);
  const rootManifest = readYaml(join(fixture.featureDir, "FEAT-SCOPE-009-whole-root/feature.yaml"));
  assert.equal(rootManifest.repositories[0].path, ".");
  assert.match(rootManifest.repositories[0].root_scope_justification, /build-system migration/);
});

test("changed-coverage CLI accepts exactly 40 or 64 lowercase SHA characters", async (t) => {
  const fixture = createProjectFixture(distributionRoot);
  t.after(() => fixture.cleanup());
  mkdirSync(join(fixture.root, "src"), { recursive: true });
  writeFileSync(join(fixture.root, "src/app.js"), "export const ok = true;\n");
  const script = fixture.scripts.checkChanged;
  const common = [script, "--repo-root", fixture.root, "--policy", fixture.policyPath, "--file", "src/app.js", "--json"];
  for (const [baseSha, codeSha] of [["a".repeat(40), "b".repeat(64)], ["c".repeat(64), "d".repeat(40)]]) {
    const result = run(process.execPath, [...common, "--base-sha", baseSha, "--code-sha", codeSha]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.target_base_sha, baseSha);
    assert.equal(report.code_sha, codeSha);
    assert.doesNotMatch(report.errors.join(" "), /40 或 64 位/);
  }

  const invalid = ["a".repeat(39), "a".repeat(41), "b".repeat(63), "b".repeat(65), "A".repeat(40), `sha256:${"c".repeat(64)}`];
  for (const value of invalid) {
    await t.test(`reject ${value.length}-character/noncanonical input`, () => {
      const result = run(process.execPath, [...common, "--base-sha", value, "--code-sha", "d".repeat(40)]);
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /40 或 64 位小写 SHA/);
    });
  }
});
