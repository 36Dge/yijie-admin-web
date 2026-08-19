import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import YAML from "yaml";
import { approvalPayloadDigest, canonicalApprovalPayload } from "../scripts/approval-attestation.mjs";
import { decodeGitPathOutput } from "../scripts/check-changed-feature-coverage.mjs";
import { legacyTreeDigest, loadLegacyPins } from "../scripts/legacy-v1.mjs";
import { NEUTRAL_REPOSITORY_ID, projectConfig, repositoryRegistry } from "./project-fixture.mjs";

const frameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evaluator = resolve(frameworkDir, "scripts/evaluate-feature-package.mjs");
const checkAll = resolve(frameworkDir, "scripts/check-all-feature-packages.mjs");
const checkChanged = resolve(frameworkDir, "scripts/check-changed-feature-coverage.mjs");
const trustedWorkflow = resolve(frameworkDir, "integrations/github/feature-delivery-coverage.yml");
const newFeature = resolve(frameworkDir, "scripts/new-feature.sh");
const TEST_FRAMEWORK_ROOT = "internal/tooling/quality/feature-delivery";
const projectContexts = new Map();
let standardCodeLedgerTemplate = null;
after(() => {
  if (standardCodeLedgerTemplate) rmSync(standardCodeLedgerTemplate.root, { recursive: true, force: true });
});
const runtimeScriptNames = new Map([
  [evaluator, "evaluate-feature-package.mjs"],
  [checkAll, "check-all-feature-packages.mjs"],
  [checkChanged, "check-changed-feature-coverage.mjs"],
]);

function run(command, args, options = {}) {
  let actualCommand = command;
  const actualArgs = [...args];
  let root = options.cwd ? resolve(options.cwd) : null;
  const rootIndex = actualArgs.indexOf("--repo-root");
  const repositoryRootIndex = actualArgs.indexOf("--repository-root");
  if (rootIndex >= 0) root = resolve(actualArgs[rootIndex + 1]);
  else if (repositoryRootIndex >= 0) root = resolve(actualArgs[repositoryRootIndex + 1]);
  if (!root) {
    const candidate = actualArgs.find((arg) => typeof arg === "string" && [...projectContexts.keys()].some((item) => resolve(arg) === item || resolve(arg).startsWith(`${item}/`)));
    if (candidate) root = [...projectContexts.keys()].find((item) => resolve(candidate) === item || resolve(candidate).startsWith(`${item}/`));
  }
  const context = root ? projectContexts.get(root) : null;
  if (context && actualCommand === newFeature) actualCommand = context.newFeature;
  if (context && actualCommand === process.execPath && runtimeScriptNames.has(actualArgs[0])) {
    actualArgs[0] = realpathSync(join(context.frameworkDir, "scripts", runtimeScriptNames.get(actualArgs[0])));
  }
  return spawnSync(actualCommand, actualArgs, { encoding: "utf8", ...options });
}

function git(root, ...args) {
  const result = run("git", ["-C", root, ...args]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function installProjectContext(root, { featureRoot = "features", repositoryId = NEUTRAL_REPOSITORY_ID, ci = "none", requiredGate = "G3" } = {}) {
  if (!existsSync(join(root, ".git"))) git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Coverage Owner");
  git(root, "config", "user.email", "coverage@example.invalid");
  const frameworkLink = join(root, ...TEST_FRAMEWORK_ROOT.split("/"));
  if (!existsSync(frameworkLink)) {
    mkdirSync(frameworkLink, { recursive: true });
    for (const entry of ["gate-policy.yaml", "package.json", "package-lock.json", "policies", "schemas", "scripts", "templates"]) {
      cpSync(join(frameworkDir, entry), join(frameworkLink, entry), { recursive: true });
    }
    symlinkSync(join(frameworkDir, "node_modules"), join(frameworkLink, "node_modules"), "dir");
  }
  mkdirSync(join(root, featureRoot), { recursive: true });
  mkdirSync(join(root, ".feature-delivery"), { recursive: true });
  writeYaml(join(root, ".feature-delivery.yaml"), projectConfig({
    projectId: "coverage-app",
    projectName: "Coverage App",
    repositoryId,
    frameworkRoot: TEST_FRAMEWORK_ROOT,
    featureRoot,
    governanceRoot: ".feature-delivery",
    repositoryRegistry: ".feature-delivery/repository-registry.yaml",
    ci,
    requiredGate,
    actorId: "coverage.owner",
  }));
  writeYaml(join(root, ".feature-delivery/repository-registry.yaml"), repositoryRegistry({ repositoryId, name: "coverage-app", url: "https://example.invalid/acme/coverage-app.git" }));
  if (!existsSync(join(root, ".feature-delivery/approval-trust.yaml"))) writeFileSync(join(root, ".feature-delivery/approval-trust.yaml"), emptyTrustRoot());
  if (!existsSync(join(root, ".feature-delivery/change-coverage-policy.yaml"))) {
    writeFileSync(join(root, ".feature-delivery/change-coverage-policy.yaml"), policy({
      files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false, repoId: repositoryId, requiredGate,
    }));
  }
  if (!existsSync(join(root, ".feature-delivery/legacy-v1-allowlist.txt"))) writeFileSync(join(root, ".feature-delivery/legacy-v1-allowlist.txt"), "# Empty generic baseline.\n");
  const context = {
    configPath: join(root, ".feature-delivery.yaml"),
    registryPath: join(root, ".feature-delivery/repository-registry.yaml"),
    legacyPath: join(root, ".feature-delivery/legacy-v1-allowlist.txt"),
    frameworkDir: frameworkLink,
    newFeature: join(frameworkLink, "scripts/new-feature.sh"),
  };
  projectContexts.set(resolve(root), context);
  return context;
}

function changeSetDigest(root, files, policyPath, exemptionId = "EXC-TEST-BOOTSTRAP") {
  const hash = createHash("sha256");
  hash.update(Buffer.from("codex-feature-delivery/change-set/v3\0", "utf8"));
  for (const path of [...files].sort()) {
    hash.update(Buffer.from(path, "utf8"));
    hash.update(Buffer.from([0]));
    if (!existsSync(join(root, path))) {
      hash.update(Buffer.from("deleted\0", "utf8"));
      continue;
    }
    let content = readFileSync(join(root, path));
    if (path === policyPath) {
      const source = content.toString("utf8");
      const document = YAML.parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
      const exemptions = document.get("exemptions", true);
      const matching = exemptions.items.filter((item) => item.get("id") === exemptionId);
      assert.equal(matching.length, 1);
      const digestNode = matching[0].get("head_content_digest", true);
      const [start, valueEnd] = digestNode.range;
      content = Buffer.from(`${source.slice(0, start)}sha256:<normalized-self-reference>${source.slice(valueEnd)}`, "utf8");
    }
    const mode = (lstatSync(join(root, path)).mode & 0o111) === 0 ? "100644" : "100755";
    hash.update(Buffer.from(`file\0${mode}\0${content.byteLength}\0`, "utf8"));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

function policy({ files, digest, exemptions = true, protectedPaths = [], rationale = "Regression-only bootstrap", repoId = NEUTRAL_REPOSITORY_ID, requiredGate = "G3" }) {
  return YAML.stringify({
    schema_version: 1,
    kind: "FeatureChangeCoveragePolicy",
    repository_id: repoId,
    feature_root: "features",
    required_gate: requiredGate,
    protected_paths: protectedPaths.map((rule) => ({ match: "exact", ...rule })),
    exemptions: exemptions ? [{
      id: "EXC-TEST-BOOTSTRAP",
      owner: "Test Owner",
      rationale,
      approval_reference: "test://approval",
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      one_time: true,
      changed_files: [...files].sort(),
      head_content_digest: digest,
    }] : [],
  }, { lineWidth: 0 });
}

function writePolicyWithSelfDigest(root, files, options = {}) {
  const path = options.path ?? "policy.yaml";
  writeFileSync(join(root, path), policy({ files, digest: `sha256:${"0".repeat(64)}`, ...options }));
  const digest = changeSetDigest(root, files, path);
  writeFileSync(join(root, path), policy({ files, digest, ...options }));
  assert.equal(changeSetDigest(root, files, path), digest, "normalized self digest must be stable");
  return digest;
}

function emptyTrustRoot() {
  return "schema_version: 1\nkind: FeatureDeliveryApprovalTrust\nkeys: []\n";
}

const E2E_ROLES = ["accountable_owner", "requirement_owner", "technical_owner", "verifier", "reviewer", "release_owner"];

function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"), { uniqueKeys: true });
}

function writeYaml(path, value) {
  writeFileSync(path, YAML.stringify(value, { lineWidth: 0 }));
}

function fillMarkdownTokens(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fillMarkdownTokens(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/\{\{[A-Z0-9_]+\}\}/g, "filled"));
    }
  }
}

function e2eIso(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

function e2eSha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function e2eAuthorization(baseSha, scopePath = "src") {
  return {
    instances: ["SLC-001"],
    repositories: [NEUTRAL_REPOSITORY_ID],
    paths: [{ repository: NEUTRAL_REPOSITORY_ID, path: scopePath }],
    base_refs: [{ repository: NEUTRAL_REPOSITORY_ID, sha: baseSha }],
    environment: "local_engineering",
    account: null,
    data_classification: "internal",
    budget: { currency: "USD", maximum: 0 },
    allowed_actions: ["workspace_edit", "local_test"],
    excluded_actions: ["external_write", "real_sensitive_data", "paid_call", "deployment", "migration", "irreversible_operation"],
    stop_conditions: ["subject_change", "scope_change", "evidence_failure"],
    required_evidence: ["baseline", "test", "review"],
    reauthorize_on: ["scope_change", "subject_change", "artifact_change", "environment_change", "rollback_change", "external_write", "real_sensitive_data", "paid_call", "deployment", "migration", "irreversible_operation", "expiry"],
  };
}

function emptyE2eAuthorization() {
  return {
    instances: [], repositories: [], paths: [], base_refs: [], environment: null, account: null,
    data_classification: null, budget: { currency: null, maximum: null }, allowed_actions: [], excluded_actions: [],
    stop_conditions: [], required_evidence: [], reauthorize_on: [],
  };
}

function e2eSubject(report, gate, { codeSha = null, baseSha = null } = {}) {
  return {
    policy_digest: report.digests.policy_digest,
    declaration_digest: report.digests.declaration_digest,
    intake_digest: report.digests.intake_digest,
    scope_digest: report.digests.scope_digest,
    build_digest: report.digests.build_digest,
    boundary_digest: null,
    slice_digest: gate === "G3" ? report.digests.slice_digests["SLC-001"] : null,
    engineering_digest: report.digests.engineering_digest,
    release_digest: report.digests.release_digest,
    spec_digest: report.digests.spec_digest,
    code_refs: codeSha ? [{ repository: NEUTRAL_REPOSITORY_ID, sha: codeSha, base_sha: baseSha }] : [],
    artifact_refs: [],
    engineering_decision_ref: null,
    environment_ref: null,
    account_ref: null,
    rollback_ref: null,
  };
}

function signE2eDecision(manifest, decision, privateKey) {
  const payload = canonicalApprovalPayload(manifest, decision);
  decision.attestation = {
    scheme: "ed25519-v1",
    key_id: "coverage-owner-key",
    payload_digest: approvalPayloadDigest(manifest, decision),
    signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
  return decision;
}

function e2eDecision({ manifest, report, privateKey, id, sequence, gate, roles, evidenceRefs = [], authorization = emptyE2eAuthorization(), codeSha = null, baseSha = null }) {
  return signE2eDecision(manifest, {
    id,
    sequence,
    gate,
    instance: gate === "G3" ? "SLC-001" : "feature",
    state: "passed",
    actor: { id: "Coverage Owner", type: "human" },
    roles,
    decided_at: e2eIso(-20 + sequence),
    valid_until: gate === "G2" ? e2eIso(60) : null,
    subject: e2eSubject(report, gate, { codeSha, baseSha }),
    evidence_refs: evidenceRefs,
    authorization,
    attestation: null,
    rationale: `${gate} coverage E2E`,
    supersedes: null,
  }, privateKey);
}

function e2eEvidence({ id, kind, codeSha, baseSha = null, acceptanceCriteria = [], instance = "feature" }) {
  return {
    id,
    kind,
    recorded_at: e2eIso(-25),
    producer: { id: "ci/coverage", type: "ci" },
    subject: {
      instance,
      repository: NEUTRAL_REPOSITORY_ID,
      cwd: ".",
      code_sha: codeSha,
      base_sha: baseSha,
      environment_ref: "local",
      account_ref: null,
      artifact_refs: [],
      acceptance_criteria: acceptanceCriteria,
    },
    execution: {
      command: "node --test",
      tool: "node",
      tool_version: process.version,
      started_at: e2eIso(-27),
      finished_at: e2eIso(-26),
      exit_code: 0,
      result: "passed",
    },
    artifacts: [{ uri: `ci://coverage/${id}`, digest: e2eSha(id), retention_until: e2eIso(60 * 24 * 30) }],
    notes: "Coverage E2E evidence",
  };
}

function evaluatorReport(root, trustPath, packageDir, gate = null) {
  const args = ["--trust-root", trustPath, "--repository-root", root, "--json"];
  if (gate) args.push("--gate", gate, ...(gate === "G3" ? ["--instance", "SLC-001"] : []));
  args.push(packageDir);
  const result = run(process.execPath, [evaluator, ...args]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function cloneCodeLedgerFixture(t, template) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "cfd-code-ledger-clone-")));
  const root = join(parent, "repository");
  cpSync(template.root, root, { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const frameworkDir = join(root, ...TEST_FRAMEWORK_ROOT.split("/"));
  projectContexts.set(root, {
    configPath: join(root, ".feature-delivery.yaml"),
    registryPath: join(root, ".feature-delivery/repository-registry.yaml"),
    legacyPath: join(root, ".feature-delivery/legacy-v1-allowlist.txt"),
    frameworkDir,
    newFeature: join(frameworkDir, "scripts/new-feature.sh"),
  });
  return {
    ...template,
    root,
    packageDir: join(root, "features/FEAT-990-coverage-e2e"),
    trustPath: join(root, "approval-trust.yaml"),
  };
}

function createCodeThenLedgerFixture(t, { implementationPath = "src/app.js", protectedPaths = [] } = {}) {
  const reusable = implementationPath === "src/app.js" && protectedPaths.length === 0;
  if (reusable && standardCodeLedgerTemplate) return cloneCodeLedgerFixture(t, standardCodeLedgerTemplate);
  const root = mkdtempSync(join(tmpdir(), "cfd-code-ledger-e2e-"));
  if (!reusable) t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trustPath = join(root, "approval-trust.yaml");
  writeYaml(trustPath, {
    schema_version: 1,
    kind: "FeatureDeliveryApprovalTrust",
    keys: [{
      id: "coverage-owner-key",
      actor: "Coverage Owner",
      roles: E2E_ROLES,
      gates: ["G0", "G1", "G2", "G3", "G4"],
      profiles: ["lite", "controlled"],
      targets: ["local_engineering"],
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
      valid_from: "2020-01-01T00:00:00Z",
      valid_until: null,
    }],
  });
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "policy.yaml"), policy({
    files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false, repoId: NEUTRAL_REPOSITORY_ID, protectedPaths,
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "target base");
  const base = git(root, "rev-parse", "HEAD");

  const scopePath = implementationPath.split("/")[0];
  const generated = run(newFeature, [
    "FEAT-990", "coverage-e2e", "--profile", protectedPaths.length > 0 ? "lite" : "lite",
    "--target", "local_engineering", "--title", "Coverage E2E", "--owner", "Coverage Owner", "--scope", scopePath,
  ], { cwd: root });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const packageDir = join(root, "features/FEAT-990-coverage-e2e");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const evidencePath = join(packageDir, "evidence.yaml");
  const decisionsPath = join(packageDir, "decisions.yaml");
  const manifest = readYaml(manifestPath);
  manifest.feature.owners.role_assignments = [{ actor: "Coverage Owner", roles: E2E_ROLES }];
  manifest.repositories[0].path = scopePath;
  manifest.repositories[0].root_scope_justification = null;
  manifest.repositories[0].baseline = { sha: base, evidence_id: "EV-FEAT-990-BASE" };
  manifest.slices[0].paths = [{ repository: NEUTRAL_REPOSITORY_ID, path: scopePath }];
  manifest.slices[0].authorization_decision_id = "DEC-FEAT-990-003";
  writeYaml(manifestPath, manifest);
  const evidenceLedger = readYaml(evidencePath);
  evidenceLedger.entries = [e2eEvidence({ id: "EV-FEAT-990-BASE", kind: "baseline", codeSha: base })];
  writeYaml(evidencePath, evidenceLedger);
  const initial = evaluatorReport(root, trustPath, packageDir);
  const baselineRef = { id: "EV-FEAT-990-BASE", digest: initial.digests.evidence["EV-FEAT-990-BASE"] };
  const decisionLedger = readYaml(decisionsPath);
  decisionLedger.entries = [
    e2eDecision({ manifest, report: initial, privateKey, id: "DEC-FEAT-990-001", sequence: 1, gate: "G0", roles: ["requirement_owner"] }),
    e2eDecision({ manifest, report: initial, privateKey, id: "DEC-FEAT-990-002", sequence: 2, gate: "G1", roles: ["technical_owner"] }),
    e2eDecision({ manifest, report: initial, privateKey, id: "DEC-FEAT-990-003", sequence: 3, gate: "G2", roles: ["technical_owner"], evidenceRefs: [baselineRef], authorization: e2eAuthorization(base, scopePath) }),
  ];
  writeYaml(decisionsPath, decisionLedger);
  evaluatorReport(root, trustPath, packageDir, "G2");

  const implementationFile = join(root, implementationPath);
  mkdirSync(dirname(implementationFile), { recursive: true });
  writeFileSync(implementationFile, "export const delivered = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "implementation C");
  const code = git(root, "rev-parse", "HEAD");

  evidenceLedger.entries.push(e2eEvidence({
    id: "EV-FEAT-990-TEST",
    kind: "unit_test",
    codeSha: code,
    baseSha: base,
    acceptanceCriteria: ["AC-001"],
    instance: "SLC-001",
  }));
  writeYaml(evidencePath, evidenceLedger);
  const withEvidence = evaluatorReport(root, trustPath, packageDir);
  const testRef = { id: "EV-FEAT-990-TEST", digest: withEvidence.digests.evidence["EV-FEAT-990-TEST"] };
  decisionLedger.entries.push(e2eDecision({
    manifest,
    report: withEvidence,
    privateKey,
    id: "DEC-FEAT-990-G3",
    sequence: 4,
    gate: "G3",
    roles: ["verifier"],
    evidenceRefs: [testRef],
    codeSha: code,
    baseSha: base,
  }));
  writeYaml(decisionsPath, decisionLedger);
  evaluatorReport(root, trustPath, packageDir, "G3");
  git(root, "add", ".");
  git(root, "commit", "-qm", "signed ledger D");
  const head = git(root, "rev-parse", "HEAD");
  const fixture = { root, base, code, head, packageDir, trustPath, implementationPath };
  if (reusable) {
    standardCodeLedgerTemplate = fixture;
    return cloneCodeLedgerFixture(t, fixture);
  }
  return fixture;
}

test("legacy pins bind basename and normalized tree content while remaining valid=false", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-legacy-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = installProjectContext(root);
  const name = "FEAT-100-legacy-sample";
  const packageDir = join(root, "features", name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "feature.yaml"), "schema_version: 1\n");
  writeFileSync(join(packageDir, "00-feature-brief.md"), "# Frozen legacy sample\n");
  const pinnedDigest = legacyTreeDigest(packageDir);
  writeFileSync(context.legacyPath, `${name} ${pinnedDigest}\n`);
  const pins = loadLegacyPins(context.legacyPath);
  assert.equal(pins.get(name), pinnedDigest);

  const batch = run(process.execPath, [checkAll, "--repository-root", root, "--project-config", context.configPath]);
  assert.equal(batch.status, 0, `${batch.stdout}\n${batch.stderr}`);
  assert.match(batch.stdout, /legacy_recognized=1/);

  const reportResult = run(process.execPath, [evaluator, "--allow-legacy", "--json", packageDir]);
  assert.notEqual(reportResult.status, 0, "legacy recognition must remain a non-success process result");
  const report = JSON.parse(reportResult.stdout);
  assert.deepEqual({ valid: report.valid, legacy: report.legacy, recognized: report.recognized, verdict: report.verdict }, {
    valid: false,
    legacy: true,
    recognized: true,
    verdict: "LEGACY_RECOGNIZED",
  });

  writeFileSync(join(packageDir, ".DS_Store"), "ignored metadata");
  assert.equal(run(process.execPath, [checkAll, "--repository-root", root, "--project-config", context.configPath]).status, 0, ".DS_Store must not affect the normalized historical tree");
  writeFileSync(join(packageDir, "00-feature-brief.md"), `${readFileSync(join(packageDir, "00-feature-brief.md"), "utf8")}\nmutation\n`);
  const mutated = run(process.execPath, [checkAll, "--repository-root", root, "--project-config", context.configPath]);
  assert.notEqual(mutated.status, 0, `${mutated.stdout}\n${mutated.stderr}`);
  assert.match(`${mutated.stdout}${mutated.stderr}`, /tree digest|normalized tree digest|只读 pin/i);
});

test("an unregistered schema v1 directory is rejected even with --allow-legacy", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-legacy-unknown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installProjectContext(root);
  const packageDir = join(root, "features/FEAT-101-unregistered");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "feature.yaml"), "schema_version: 1\n");
  const result = run(process.execPath, [evaluator, "--allow-legacy", "--json", packageDir]);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}\nspawnargs=${JSON.stringify(result.spawnargs)}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.recognized, false);
  assert.equal(report.verdict, "LEGACY_REJECTED");
});

test("explicit-file exemption requires an exact file set and head-content digest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-change-exemption-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installProjectContext(root);
  writeFileSync(join(root, "framework.md"), "approved bootstrap\n");
  const files = ["framework.md", "policy.yaml"].sort();
  writePolicyWithSelfDigest(root, files, { protectedPaths: [
    { path: "framework.md", mode: "external_digest_only" },
    { path: "policy.yaml", mode: "external_digest_only" },
  ] });
  const withIndependentExemption = YAML.parse(readFileSync(join(root, "policy.yaml"), "utf8"));
  withIndependentExemption.exemptions.push({
    id: "EXC-INDEPENDENT",
    owner: "Test Owner",
    rationale: "Must remain digest-bound",
    approval_reference: "test://independent",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    one_time: true,
    changed_files: ["future.txt"],
    head_content_digest: `sha256:${"1".repeat(64)}`,
  });
  writeFileSync(join(root, "policy.yaml"), YAML.stringify(withIndependentExemption, { lineWidth: 0 }));
  withIndependentExemption.exemptions[0].head_content_digest = changeSetDigest(root, files, "policy.yaml");
  writeFileSync(join(root, "policy.yaml"), YAML.stringify(withIndependentExemption, { lineWidth: 0 }));

  const accepted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "framework.md", "--file", "policy.yaml", "--json"]);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).verdict, "EXEMPTION_APPLIED");

  chmodSync(join(root, "framework.md"), 0o755);
  const modeTamper = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "framework.md", "--file", "policy.yaml", "--json"]);
  assert.notEqual(modeTamper.status, 0, "100644 -> 100755 must alter the v3 change-set digest");
  chmodSync(join(root, "framework.md"), 0o644);

  const approvedPolicy = readFileSync(join(root, "policy.yaml"), "utf8");
  const changedIndependentDigest = YAML.parse(approvedPolicy);
  changedIndependentDigest.exemptions[1].head_content_digest = `sha256:${"2".repeat(64)}`;
  writeFileSync(join(root, "policy.yaml"), YAML.stringify(changedIndependentDigest, { lineWidth: 0 }));
  const independentTamper = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "framework.md", "--file", "policy.yaml", "--json"]);
  assert.notEqual(independentTamper.status, 0, "only the matching exemption's self-reference may be normalized");

  writeFileSync(join(root, "policy.yaml"), approvedPolicy);
  const changedPolicy = YAML.parse(approvedPolicy);
  changedPolicy.exemptions[0].rationale = "unreviewed policy metadata mutation";
  writeFileSync(join(root, "policy.yaml"), YAML.stringify(changedPolicy, { lineWidth: 0 }));
  const policyTamper = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "framework.md", "--file", "policy.yaml", "--json"]);
  assert.notEqual(policyTamper.status, 0, "all policy content except the digest field itself must affect the change-set digest");

  writeFileSync(join(root, "policy.yaml"), approvedPolicy);
  writeFileSync(join(root, "framework.md"), "tampered bootstrap\n");
  const rejected = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "framework.md", "--file", "policy.yaml", "--json"]);
  assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
  assert.notEqual(JSON.parse(rejected.stdout).verdict, "EXEMPTION_APPLIED");
});

test("git mode reads exemption policy from base and rejects PR-head self-authorization", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-change-base-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "policy.yaml"), policy({ files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false }));
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");

  writeFileSync(join(root, "covered.txt"), "head attempts self approval\n");
  const files = ["covered.txt", "policy.yaml"].sort();
  writePolicyWithSelfDigest(root, files);
  git(root, "add", ".");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD");

  const result = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", head, "--json"]);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.policy_source, "target_base");
  assert.equal(report.exemption, null);
});

test("first CI integration can use only an exact bootstrap-head exemption", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-change-policy-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");

  writeFileSync(join(root, "framework.md"), "bootstrap\n");
  const files = ["features/.keep", "framework.md", "policy.yaml"].sort();
  writeFileSync(join(root, "features/.keep"), "");
  const digest = writePolicyWithSelfDigest(root, files);
  git(root, "add", ".");
  git(root, "commit", "-qm", "bootstrap");
  const head = git(root, "rev-parse", "HEAD");

  const unpinned = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", base, "--head", head, "--allow-policy-bootstrap", "--json"]);
  assert.notEqual(unpinned.status, 0, `${unpinned.stdout}\n${unpinned.stderr}`);
  assert.match(`${unpinned.stdout}\n${unpinned.stderr}`, /bootstrap.*digest|CFD_BOOTSTRAP_APPROVAL_DIGEST|pin/i);

  const accepted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", base, "--head", head, "--allow-policy-bootstrap", "--bootstrap-digest", digest, "--json"]);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  const report = JSON.parse(accepted.stdout);
  assert.equal(report.policy_source, "bootstrap_head");
  assert.equal(report.verdict, "EXEMPTION_APPLIED");
});

test("git mode binds G3 to implementation commit C and permits a signed ledger-only head D", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  const result = run(process.execPath, [
    checkChanged,
    "--repo-root", fixture.root,
    "--repo-id", NEUTRAL_REPOSITORY_ID,
    "--policy", join(fixture.root, "policy.yaml"),
    "--trust-root", fixture.trustPath,
    "--base", fixture.base,
    "--head", fixture.head,
    "--json",
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.verdict, "COVERED");
  assert.equal(report.target_base_sha, fixture.base);
  assert.equal(report.diff_base_sha, fixture.base);
  assert.equal(report.code_sha, fixture.code);
  assert.equal(report.head_sha, fixture.head);
  assert.notEqual(report.code_sha, report.head_sha);
  assert.equal(report.coverage.find((item) => item.path === fixture.implementationPath)?.gates.at(-1)?.gate, "G3");
});

test("a later ordinary change becomes C and invalidates a G3 decision bound to the older implementation", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  writeFileSync(join(fixture.root, fixture.implementationPath), "export const delivered = false;\n");
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "ordinary change after signed ledger");
  const finalHead = git(fixture.root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", finalHead, "--json"]);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.code_sha, finalHead);
  assert.match(report.errors.join(" "), /G3.*未绑定 implementation commit/);
});

test("a package-ledger-only diff is metadata-only and reports code_sha null", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.code, "--head", fixture.head, "--json"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.code_sha, null);
  assert.equal(report.head_sha, fixture.head);
});

test("a Feature package may not smuggle an undeclared tail file", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  writeFileSync(join(fixture.packageDir, "undeclared.tmp"), "not in manifest artifacts\n");
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "undeclared package tail");
  const finalHead = git(fixture.root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", finalHead, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /未声明的路径.*undeclared\.tmp/);
});

test("first-parent history rejects merge commits", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  const originalBranch = git(fixture.root, "branch", "--show-current");
  git(fixture.root, "checkout", "-qb", "side-change");
  writeFileSync(join(fixture.root, "side.txt"), "side\n");
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "side");
  git(fixture.root, "checkout", "-q", originalBranch);
  writeFileSync(join(fixture.root, "main.txt"), "main\n");
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "main");
  git(fixture.root, "merge", "--no-ff", "-qm", "merge is forbidden", "side-change");
  const finalHead = git(fixture.root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", finalHead, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /不允许 merge commit/);
});

test("append-only validation runs at every commit and catches rewriting a newly appended entry", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  const ledger = readYaml(join(fixture.packageDir, "decisions.yaml"));
  ledger.entries.push({ id: "DEC-TAIL", rationale: "immutable after append" });
  writeYaml(join(fixture.packageDir, "decisions.yaml"), ledger);
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "append one ledger entry");
  ledger.entries.at(-1).rationale = "rewritten on the next commit";
  writeYaml(join(fixture.packageDir, "decisions.yaml"), ledger);
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "rewrite newly appended entry");
  const finalHead = git(fixture.root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", finalHead, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /decisions\.yaml.*只允许尾部追加/);
});

test("candidate discovery rejects duplicate v2 feature IDs", (t) => {
  const fixture = createCodeThenLedgerFixture(t);
  cpSync(fixture.packageDir, join(fixture.root, "features/FEAT-991-duplicate-id"), { recursive: true });
  git(fixture.root, "add", ".");
  git(fixture.root, "commit", "-qm", "duplicate v2 identity");
  const finalHead = git(fixture.root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", finalHead, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /重复 v2 feature\.id=FEAT-990/);
});

test("ordinary G3 cannot authorize a runtime TCB change", (t) => {
  const fixture = createCodeThenLedgerFixture(t, {
    implementationPath: ".github/workflows/untrusted.yml",
    protectedPaths: [{ path: ".github/workflows", match: "prefix", mode: "external_digest_only" }],
  });
  const result = run(process.execPath, [checkChanged, "--repo-root", fixture.root, "--repo-id", NEUTRAL_REPOSITORY_ID, "--policy", join(fixture.root, "policy.yaml"), "--trust-root", fixture.trustPath, "--base", fixture.base, "--head", fixture.head, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /external_digest_only.*必须独立提交|CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST/);
});

test("git mode rejects a target base that is not an ancestor of candidate head", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-target-vs-diff-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(root, "policy.yaml"), policy({ files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false }));
  writeFileSync(join(root, "README.md"), "common\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "common");
  const common = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "candidate");
  writeFileSync(join(root, "covered.txt"), "candidate content\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "candidate");
  const head = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "target", common);
  writeFileSync(join(root, "covered.txt"), "candidate content\n");
  const digest = changeSetDigest(root, ["covered.txt"], "policy.yaml");
  rmSync(join(root, "covered.txt"));
  writeFileSync(join(root, "policy.yaml"), policy({ files: ["covered.txt"], digest }));
  writeFileSync(join(root, "README.md"), "target advanced\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "target advances");
  const targetBase = git(root, "rev-parse", "HEAD");

  const result = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", targetBase, "--head", head, "--json"]);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.target_base_sha, targetBase);
  assert.match(report.errors.join(" "), /必须是.*祖先|更新分支/);
});

test("repo-internal policy and trust are read as regular blobs from target base", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-base-blob-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "real-policy.yaml"), policy({ files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false }));
  // A worktree realpath would make this appear usable; the Git mode must reject 120000.
  symlinkSync("real-policy.yaml", join(root, "policy.yaml"));
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  git(root, "add", ".");
  git(root, "commit", "-qm", "symlink policy");
  const sha = git(root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", sha, "--head", sha, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /symlink|120000|普通 Git blob/);

  const trustRoot = mkdtempSync(join(tmpdir(), "cfd-base-trust-mode-"));
  t.after(() => rmSync(trustRoot, { recursive: true, force: true }));
  git(trustRoot, "init", "-q");
  installProjectContext(trustRoot);
  writeFileSync(join(trustRoot, "features/.keep"), "");
  writeFileSync(join(trustRoot, "policy.yaml"), policy({ files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false }));
  writeFileSync(join(trustRoot, "real-trust.yaml"), emptyTrustRoot());
  symlinkSync("real-trust.yaml", join(trustRoot, "approval-trust.yaml"));
  writeFileSync(join(trustRoot, "README.md"), "base\n");
  git(trustRoot, "add", ".");
  git(trustRoot, "commit", "-qm", "symlink trust");
  const trustBase = git(trustRoot, "rev-parse", "HEAD");
  writeFileSync(join(trustRoot, "README.md"), "head\n");
  git(trustRoot, "add", ".");
  git(trustRoot, "commit", "-qm", "candidate");
  const trustHead = git(trustRoot, "rev-parse", "HEAD");
  const trustResult = run(process.execPath, [checkChanged, "--repo-root", trustRoot, "--policy", join(trustRoot, "policy.yaml"), "--trust-root", join(trustRoot, "approval-trust.yaml"), "--base", trustBase, "--head", trustHead, "--json"]);
  assert.notEqual(trustResult.status, 0);
  assert.match(JSON.parse(trustResult.stdout).errors.join(" "), /symlink|120000|普通 Git blob/);
});

test("coverage policy is closed and exemptions are valid only in their active time window", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-policy-closed-time-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  installProjectContext(root);
  writeFileSync(join(root, "changed.txt"), "content\n");
  const unknown = YAML.parse(policy({ files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false }));
  unknown.unreviewed = true;
  writeYaml(join(root, "policy.yaml"), unknown);
  const unknownResult = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "changed.txt", "--json"]);
  assert.notEqual(unknownResult.status, 0);
  assert.match(JSON.parse(unknownResult.stdout).errors.join(" "), /不允许字段 unreviewed/);

  const future = YAML.parse(policy({ files: ["changed.txt"], digest: `sha256:${"0".repeat(64)}` }));
  future.exemptions[0].created_at = "2098-01-01T00:00:00Z";
  future.exemptions[0].expires_at = "2099-01-01T00:00:00Z";
  writeYaml(join(root, "policy.yaml"), future);
  const futureResult = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--file", "changed.txt", "--json"]);
  assert.notEqual(futureResult.status, 0);
  assert.match(JSON.parse(futureResult.stdout).errors.join(" "), /created_at 不得位于未来/);
});

test("existing v2 decision and evidence ledgers allow only canonical tail append", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-ledger-prefix-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  const packageRoot = join(root, "features/FEAT-900-ledger");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(packageRoot, "feature.yaml"), "schema_version: 2\nkind: FeaturePackage\nfeature: {id: FEAT-900}\n");
  const baseDecisions = { schema_version: 2, kind: "GateDecisionLedger", feature_id: "FEAT-900", entries: [{ id: "DEC-1", rationale: "immutable" }] };
  const appendedDecisions = { kind: "GateDecisionLedger", schema_version: 2, feature_id: "FEAT-900", entries: [{ rationale: "immutable", id: "DEC-1" }, { id: "DEC-2", rationale: "tail" }] };
  const baseEvidence = { schema_version: 2, kind: "EvidenceLedger", feature_id: "FEAT-900", entries: [{ id: "EV-1", notes: "immutable" }] };
  writeFileSync(join(packageRoot, "decisions.yaml"), YAML.stringify(appendedDecisions));
  writeFileSync(join(packageRoot, "evidence.yaml"), YAML.stringify(baseEvidence));
  const changed = ["features/FEAT-900-ledger/decisions.yaml"];
  const digest = changeSetDigest(root, changed, "policy.yaml");
  writeFileSync(join(packageRoot, "decisions.yaml"), YAML.stringify(baseDecisions));
  writeFileSync(join(root, "policy.yaml"), policy({ files: changed, digest }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base ledger");
  const base = git(root, "rev-parse", "HEAD");

  writeFileSync(join(packageRoot, "decisions.yaml"), YAML.stringify(appendedDecisions));
  git(root, "add", ".");
  git(root, "commit", "-qm", "append ledger");
  const appendHead = git(root, "rev-parse", "HEAD");
  const accepted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", base, "--head", appendHead, "--json"]);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).verdict, "EXEMPTION_APPLIED");

  git(root, "checkout", "-qb", "tamper", base);
  const tamperedDecisions = structuredClone(baseDecisions);
  tamperedDecisions.entries[0].rationale = "rewritten history";
  const tamperedEvidence = structuredClone(baseEvidence);
  tamperedEvidence.entries[0].notes = "rewritten history";
  writeFileSync(join(packageRoot, "decisions.yaml"), YAML.stringify(tamperedDecisions));
  writeFileSync(join(packageRoot, "evidence.yaml"), YAML.stringify(tamperedEvidence));
  git(root, "add", ".");
  git(root, "commit", "-qm", "tamper ledgers");
  const tamperHead = git(root, "rev-parse", "HEAD");
  const rejected = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--base", base, "--head", tamperHead, "--json"]);
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.parse(rejected.stdout).errors.join(" "), /decisions\.yaml.*只允许尾部追加|evidence\.yaml.*只允许尾部追加/);
});

test("approval trust rotation is isolated, strict, and pinned by the admin governance channel", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-governance-digest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(root, "policy.yaml"), policy({
    files: [],
    digest: `sha256:${"0".repeat(64)}`,
    exemptions: false,
    protectedPaths: [
      { path: "approval-trust.yaml", match: "prefix", mode: "controlled_g4_or_exemption" },
      { path: "approval-trust.yaml", mode: "external_digest_only" },
      { path: "runtime.mjs", mode: "external_digest_only" },
    ],
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base governance");
  const base = git(root, "rev-parse", "HEAD");

  const { publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    schema_version: 1,
    kind: "FeatureDeliveryApprovalTrust",
    keys: [{
      id: "KEY-1", actor: "Human Owner", roles: ["accountable_owner"], gates: ["G0"], profiles: ["lite"],
      targets: ["local_engineering"], public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      status: "active", valid_from: "2026-01-01T00:00:00Z", valid_until: null,
    }],
  };
  writeFileSync(join(root, "approval-trust.yaml"), YAML.stringify(trust, { lineWidth: 0 }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "register key");
  const head = git(root, "rev-parse", "HEAD");
  const digest = changeSetDigest(root, ["approval-trust.yaml"], "policy.yaml");

  const unpinned = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", head, "--json"]);
  assert.notEqual(unpinned.status, 0);
  assert.match(JSON.parse(unpinned.stdout).errors.join(" "), /CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST/);

  const accepted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", head, "--governance-digest", digest, "--json"]);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).verdict, "GOVERNANCE_DIGEST_APPLIED");

  writeFileSync(join(root, "extra.txt"), "must not ride with trust rotation\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "bundle unrelated change");
  const bundledHead = git(root, "rev-parse", "HEAD");
  const bundledDigest = changeSetDigest(root, ["approval-trust.yaml", "extra.txt"], "policy.yaml");
  const bundled = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", bundledHead, "--governance-digest", bundledDigest, "--json"]);
  assert.notEqual(bundled.status, 0);
  assert.match(JSON.parse(bundled.stdout).errors.join(" "), /必须独立提交/);

  git(root, "checkout", "-qb", "bundled-external-tcb", base);
  writeFileSync(join(root, "approval-trust.yaml"), YAML.stringify(trust, { lineWidth: 0 }));
  writeFileSync(join(root, "runtime.mjs"), "export const trusted = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "bundle trust and external runtime TCB");
  const externalBundleHead = git(root, "rev-parse", "HEAD");
  const externalBundleDigest = changeSetDigest(root, ["approval-trust.yaml", "runtime.mjs"], "policy.yaml");
  const externalBundle = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", externalBundleHead, "--governance-digest", externalBundleDigest, "--json"]);
  assert.notEqual(externalBundle.status, 0);
  assert.match(JSON.parse(externalBundle.stdout).errors.join(" "), /trust-only/);

  git(root, "checkout", "-qb", "invalid-trust", base);
  const invalidTrust = structuredClone(trust);
  invalidTrust.keys[0].unreviewed_scope = true;
  writeFileSync(join(root, "approval-trust.yaml"), YAML.stringify(invalidTrust, { lineWidth: 0 }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "invalid trust root");
  const invalidHead = git(root, "rev-parse", "HEAD");
  const invalidDigest = changeSetDigest(root, ["approval-trust.yaml"], "policy.yaml");
  const invalid = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", invalidHead, "--governance-digest", invalidDigest, "--json"]);
  assert.notEqual(invalid.status, 0);
  assert.match(JSON.parse(invalid.stdout).errors.join(" "), /不允许字段 unreviewed_scope/);
});

test("external digest governance covers runtime TCB files and validates candidate structure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-runtime-tcb-governance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "policy.yaml"), policy({
    files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false,
    protectedPaths: [{ path: "package.json", mode: "external_digest_only" }],
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base runtime TCB");
  const base = git(root, "rev-parse", "HEAD");

  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "valid runtime TCB update");
  const validHead = git(root, "rev-parse", "HEAD");
  const validDigest = changeSetDigest(root, ["package.json"], "policy.yaml");
  const accepted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", validHead, "--governance-digest", validDigest, "--json"]);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(JSON.parse(accepted.stdout).verdict, "GOVERNANCE_DIGEST_APPLIED");

  git(root, "checkout", "-qb", "invalid-json", base);
  writeFileSync(join(root, "package.json"), "{invalid json\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "invalid runtime TCB update");
  const invalidHead = git(root, "rev-parse", "HEAD");
  const invalidDigest = changeSetDigest(root, ["package.json"], "policy.yaml");
  const rejected = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", invalidHead, "--governance-digest", invalidDigest, "--json"]);
  assert.notEqual(rejected.status, 0);
  assert.match(JSON.parse(rejected.stdout).errors.join(" "), /JSON 非法/);
});

test("policy snapshots are content-addressed, strict, immutable, and required by an active switch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-policy-snapshot-governance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  mkdirSync(join(root, "framework/policies"), { recursive: true });
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  const activeSource = readFileSync(join(frameworkDir, "gate-policy.yaml"), "utf8");
  const activeDigest = `sha256:${createHash("sha256").update(activeSource).digest("hex")}`;
  const activeSnapshot = `framework/policies/${activeDigest.slice(7)}.yaml`;
  writeFileSync(join(root, "framework/gate-policy.yaml"), activeSource);
  writeFileSync(join(root, activeSnapshot), activeSource);
  writeFileSync(join(root, "policy.yaml"), policy({
    files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false,
    protectedPaths: [
      { path: "framework/gate-policy.yaml", mode: "external_digest_only" },
      { path: "framework/policies", match: "prefix", mode: "external_digest_only" },
    ],
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base policy registry");
  const base = git(root, "rev-parse", "HEAD");

  const nextPolicy = YAML.parse(activeSource, { uniqueKeys: true });
  nextPolicy.policy.version = "2.0.1";
  const nextSource = YAML.stringify(nextPolicy, { lineWidth: 0 });
  const nextDigest = `sha256:${createHash("sha256").update(nextSource).digest("hex")}`;
  const nextSnapshot = `framework/policies/${nextDigest.slice(7)}.yaml`;

  writeFileSync(join(root, nextSnapshot), nextSource);
  git(root, "add", ".");
  git(root, "commit", "-qm", "prestage valid next policy snapshot");
  const validSnapshotHead = git(root, "rev-parse", "HEAD");
  const validSnapshotDigest = changeSetDigest(root, [nextSnapshot], "policy.yaml");
  const validSnapshot = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", validSnapshotHead, "--governance-digest", validSnapshotDigest, "--json"]);
  assert.equal(validSnapshot.status, 0, `${validSnapshot.stdout}\n${validSnapshot.stderr}`);

  git(root, "checkout", "-qb", "wrong-snapshot-name", base);
  const wrongSnapshot = `framework/policies/${"0".repeat(64)}.yaml`;
  writeFileSync(join(root, wrongSnapshot), nextSource);
  git(root, "add", ".");
  git(root, "commit", "-qm", "wrong snapshot name");
  const wrongHead = git(root, "rev-parse", "HEAD");
  const wrongDigest = changeSetDigest(root, [wrongSnapshot], "policy.yaml");
  const wrong = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", wrongHead, "--governance-digest", wrongDigest, "--json"]);
  assert.notEqual(wrong.status, 0);
  assert.match(JSON.parse(wrong.stdout).errors.join(" "), /与文件名/);

  git(root, "checkout", "-qb", "invalid-snapshot-schema", base);
  const invalidSource = "schema_version: 2\nkind: FeatureDeliveryPolicy\nnot_a_gate_policy: true\n";
  const invalidPolicyDigest = `sha256:${createHash("sha256").update(invalidSource).digest("hex")}`;
  const invalidSnapshot = `framework/policies/${invalidPolicyDigest.slice(7)}.yaml`;
  writeFileSync(join(root, invalidSnapshot), invalidSource);
  git(root, "add", ".");
  git(root, "commit", "-qm", "invalid snapshot schema");
  const invalidHead = git(root, "rev-parse", "HEAD");
  const invalidDigest = changeSetDigest(root, [invalidSnapshot], "policy.yaml");
  const invalid = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", invalidHead, "--governance-digest", invalidDigest, "--json"]);
  assert.notEqual(invalid.status, 0);
  assert.match(JSON.parse(invalid.stdout).errors.join(" "), /Schema/);

  git(root, "checkout", "-qb", "delete-snapshot", base);
  rmSync(join(root, activeSnapshot));
  git(root, "add", ".");
  git(root, "commit", "-qm", "delete historical snapshot");
  const deletedHead = git(root, "rev-parse", "HEAD");
  const deletedDigest = changeSetDigest(root, [activeSnapshot], "policy.yaml");
  const deleted = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", deletedHead, "--governance-digest", deletedDigest, "--json"]);
  assert.notEqual(deleted.status, 0);
  assert.match(JSON.parse(deleted.stdout).errors.join(" "), /不可修改或删除/);

  git(root, "checkout", "-qb", "active-without-snapshot", base);
  writeFileSync(join(root, "framework/gate-policy.yaml"), nextSource);
  git(root, "add", ".");
  git(root, "commit", "-qm", "switch active without snapshot");
  const missingHead = git(root, "rev-parse", "HEAD");
  const missingDigest = changeSetDigest(root, ["framework/gate-policy.yaml"], "policy.yaml");
  const missing = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", missingHead, "--governance-digest", missingDigest, "--json"]);
  assert.notEqual(missing.status, 0);
  assert.match(JSON.parse(missing.stdout).errors.join(" "), /内容寻址 snapshot/);

  git(root, "checkout", "-qb", "active-with-snapshot", base);
  writeFileSync(join(root, "framework/gate-policy.yaml"), nextSource);
  writeFileSync(join(root, nextSnapshot), nextSource);
  git(root, "add", ".");
  git(root, "commit", "-qm", "switch active with snapshot");
  const switchedHead = git(root, "rev-parse", "HEAD");
  const switchedFiles = ["framework/gate-policy.yaml", nextSnapshot].sort();
  const switchedDigest = changeSetDigest(root, switchedFiles, "policy.yaml");
  const switched = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", switchedHead, "--governance-digest", switchedDigest, "--json"]);
  assert.equal(switched.status, 0, `${switched.stdout}\n${switched.stderr}`);
});

test("git-derived changed paths cannot be normalized into a different protected path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfd-git-path-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  installProjectContext(root);
  writeFileSync(join(root, "features/.keep"), "");
  writeFileSync(join(root, "approval-trust.yaml"), emptyTrustRoot());
  writeFileSync(join(root, "policy.yaml"), policy({
    files: [], digest: `sha256:${"0".repeat(64)}`, exemptions: false,
    protectedPaths: [{ path: ".github", match: "prefix", mode: "external_digest_only" }],
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");

  const aliasedPath = ".github\\workflows\\evil.yml";
  writeFileSync(join(root, aliasedPath), "first bytes\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "add non-canonical path");
  const head = git(root, "rev-parse", "HEAD");
  const result = run(process.execPath, [checkChanged, "--repo-root", root, "--policy", join(root, "policy.yaml"), "--trust-root", join(root, "approval-trust.yaml"), "--base", base, "--head", head, "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join(" "), /Git path 必须保持原始/);
});

test("Git path output rejects invalid UTF-8 bytes instead of replacing them", () => {
  assert.equal(decodeGitPathOutput(Buffer.from("docs/features/FEAT-1\0")), "docs/features/FEAT-1\0");
  assert.throws(() => decodeGitPathOutput(Buffer.from([0x66, 0x80, 0x00])), /非 UTF-8 路径字节/);
});

test("GitHub workflow template uses only base-trusted execution and exact-head App statuses", () => {
  const source = readFileSync(trustedWorkflow, "utf8");
  assert.match(source, /pull_request_target:/);
  assert.match(source, /types:\s*\[[^\]]*edited[^\]]*\]/);
  assert.match(source, /environment:\s*__TRUSTED_ENVIRONMENT__/);
  assert.match(source, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(source, /permission-statuses:\s*write/);
  assert.doesNotMatch(source, /^\s*statuses:\s*write\s*$/m, "default GITHUB_TOKEN must remain read-only");
  assert.match(source, /ref:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(source, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  assert.match(source, /test "\$actual_head_sha" = "\$EXPECTED_HEAD_SHA"/);
  assert.match(source, /id:\s*verify/);
  assert.match(source, /if:\s*\$\{\{ always\(\).*status_token\.outcome == 'success'/);
  assert.match(source, /state=pending/);
  assert.match(source, /context="feature-delivery\/trusted-coverage-status"/);
  assert.equal((source.match(/^\s+HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/gm) ?? []).length, 2);
  assert.match(source, /\(cd "\$CFD_FRAMEWORK_ROOT" && npm ci --ignore-scripts\)/);
  assert.ok(source.indexOf("Publish pending candidate commit status") < source.indexOf("actions/checkout@"), "pending status must be posted immediately after the dedicated App token, before checkout/fetch");
  assert.match(source, /CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST/);
  assert.doesNotMatch(source, /checkout[^\n]*head\.sha/);
  assert.doesNotMatch(source, /secrets\.GITHUB_TOKEN/);
});
