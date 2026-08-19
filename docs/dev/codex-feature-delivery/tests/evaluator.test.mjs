import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import YAML from "yaml";
import { approvalPayloadDigest, canonicalApprovalPayload } from "../scripts/approval-attestation.mjs";
import { createProjectFixture, NEUTRAL_REPOSITORY_ID } from "./project-fixture.mjs";

const distributionFrameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = createProjectFixture(distributionFrameworkDir);
after(() => project.cleanup());
const frameworkDir = project.frameworkDir;
const newFeature = resolve(frameworkDir, "scripts/new-feature.sh");
const checker = resolve(frameworkDir, "scripts/check-feature-package.sh");
const checkAll = resolve(frameworkDir, "scripts/check-all-feature-packages.mjs");
const materializer = resolve(frameworkDir, "scripts/materialize-delivery-summary.mjs");
const boundaryMaterializer = resolve(frameworkDir, "scripts/materialize-boundary.mjs");
const signDecisionScript = resolve(frameworkDir, "scripts/sign-decision.mjs");
const initApproverKeyScript = resolve(frameworkDir, "scripts/init-approver-key.mjs");
const legacyAllowlist = project.legacyPath;

const PRIMARY_SHA = "0123456789abcdef0123456789abcdef01234567";
const SECONDARY_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const DRIFT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const ALL_ROLES = [
  "accountable_owner",
  "requirement_owner",
  "technical_owner",
  "contract_owner",
  "verifier",
  "reviewer",
  "release_owner",
];
const testTrustDirectory = mkdtempSync(join(tmpdir(), "codex-feature-delivery-trust-"));
const testTrustRoot = join(testTrustDirectory, "approval-trust.yaml");
const testApprovalPrivateKeyPath = join(testTrustDirectory, "test-owner-private.pem");
const { privateKey: testApprovalPrivateKey, publicKey: testApprovalPublicKey } = generateKeyPairSync("ed25519");
writeFileSync(testApprovalPrivateKeyPath, testApprovalPrivateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(testTrustRoot, YAML.stringify({
  schema_version: 1,
  kind: "FeatureDeliveryApprovalTrust",
  keys: [{
    id: "test-owner-key",
    actor: "Test Owner",
    roles: ALL_ROLES,
    gates: ["G0", "G1", "G2", "G2C", "G3", "G4", "G5", "G6"],
    profiles: ["lite", "standard", "controlled"],
    targets: ["local_engineering", "staging", "production"],
    public_key_pem: testApprovalPublicKey.export({ type: "spki", format: "pem" }),
    status: "active",
    valid_from: "2020-01-01T00:00:00Z",
    valid_until: null,
  }],
}, { lineWidth: 0 }));
after(() => rmSync(testTrustDirectory, { recursive: true, force: true }));

function run(command, args, options = {}) {
  const { env, ...rest } = options;
  return spawnSync(command, args, {
    encoding: "utf8",
    ...rest,
    env: { ...process.env, CFD_APPROVAL_TRUST_ROOT: testTrustRoot, ...env },
  });
}

test("unsupported schema text output fails cleanly without a stack trace", (t) => {
  const packageDir = createPackage(t, "FEAT-BAD-SCHEMA-TEXT");
  const manifestPath = join(packageDir, "feature.yaml");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("schema_version: 2", "schema_version: 999"));
  const result = run(checker, ["--project-config", project.configPath, packageDir], { cwd: project.root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID:/);
  assert.match(result.stderr, /不支持 schema_version=999/);
  assert.doesNotMatch(result.stderr, /TypeError|at outputText/);
});

function jsonReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`evaluator did not return JSON (${error.message})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function createPackage(t, id, profile = "lite", target = "local_engineering", options = {}) {
  const slug = options.slug ?? "evaluator-test";
  const title = options.title ?? "Evaluator test";
  const owner = options.owner ?? "Test Owner";
  const targetDir = join(project.featureDir, `${id}-${slug}`);
  t.after(() => rmSync(targetDir, { recursive: true, force: true }));
  const result = run(newFeature, [
    id,
    slug,
    "--profile",
    profile,
    "--target",
    target,
    "--title",
    title,
    "--owner",
    owner,
    "--scope",
    options.scope ?? "src/app",
  ], { cwd: project.root });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return targetDir;
}

function markdownFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function fillMarkdownTokens(packageDir, only = null) {
  for (const path of markdownFiles(packageDir)) {
    if (only && !only.includes(path.slice(packageDir.length + 1))) continue;
    writeFileSync(path, readFileSync(path, "utf8").replace(/\{\{[A-Z0-9_]+\}\}/g, "filled"));
  }
}

function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"), { uniqueKeys: true });
}

function writeYaml(path, value) {
  if (basename(path) === "decisions.yaml" && existsSync(join(dirname(path), "feature.yaml"))) {
    const manifest = readYaml(join(dirname(path), "feature.yaml"));
    for (const entry of value.entries ?? []) {
      if (!Object.hasOwn(entry, "attestation")) entry.attestation = null;
      if (entry.state !== "passed" || entry.attestation !== null || entry.actor?.id !== "Test Owner" || entry.actor?.type !== "human") continue;
      const payload = canonicalApprovalPayload(manifest, entry);
      entry.attestation = {
        scheme: "ed25519-v1",
        key_id: "test-owner-key",
        payload_digest: approvalPayloadDigest(manifest, entry),
        signature: sign(null, Buffer.from(payload, "utf8"), testApprovalPrivateKey).toString("base64"),
      };
    }
  }
  writeFileSync(path, YAML.stringify(value, { lineWidth: 0 }));
}

function iso(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function execution({ result = "passed", startedAt = iso(-50), finishedAt = iso(-49) } = {}) {
  return {
    command: "node --test",
    tool: "node",
    tool_version: process.version,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: result === "passed" ? 0 : 1,
    result,
  };
}

function evidence({
  id,
  kind,
  instance = "feature",
  repository = NEUTRAL_REPOSITORY_ID,
  codeSha = PRIMARY_SHA,
  baseSha = null,
  environment = "local",
  accountRef = null,
  artifactRefs = [],
  acceptanceCriteria = [],
  recordedAt = iso(-48),
  startedAt = iso(-50),
  finishedAt = iso(-49),
  artifacts = true,
} = {}) {
  return {
    id,
    kind,
    recorded_at: recordedAt,
    producer: { id: "ci/test", type: "ci" },
    subject: {
      instance,
      repository,
      cwd: ".",
      code_sha: codeSha,
      base_sha: baseSha,
      environment_ref: environment,
      account_ref: accountRef,
      artifact_refs: artifactRefs,
      acceptance_criteria: acceptanceCriteria,
    },
    execution: execution({ startedAt, finishedAt }),
    artifacts: artifacts
      ? [{ uri: `ci://test/${id}`, digest: sha256(`artifact:${id}`), retention_until: iso(60 * 24 * 30) }]
      : [],
    notes: "Regression evidence",
  };
}

function emptyAuthorization() {
  return {
    instances: [],
    repositories: [],
    paths: [],
    base_refs: [],
    environment: null,
    account: null,
    data_classification: null,
    budget: { currency: null, maximum: null },
    allowed_actions: [],
    excluded_actions: [],
    stop_conditions: [],
    required_evidence: [],
    reauthorize_on: [],
  };
}

function buildAuthorization(manifest, instances, environment = "local_engineering") {
  const paths = [...new Map(manifest.slices.flatMap((slice) => slice.paths)
    .map((item) => [`${item.repository}\0${item.path}`, item])).values()];
  return {
    instances,
    repositories: manifest.repositories.map((repository) => repository.id),
    paths,
    base_refs: manifest.repositories.map((repository) => ({ repository: repository.id, sha: repository.baseline.sha })),
    environment,
    account: environment === "local_engineering" ? null : "test-account",
    data_classification: manifest.classification.data,
    budget: { currency: "USD", maximum: 0 },
    allowed_actions: ["workspace_edit", "local_test"],
    excluded_actions: [
      "external_write",
      "real_sensitive_data",
      "paid_call",
      "deployment",
      "migration",
      "irreversible_operation",
    ],
    stop_conditions: ["subject_change", "scope_change", "evidence_failure"],
    required_evidence: ["baseline", "test", "review"],
    reauthorize_on: [
      "scope_change",
      "subject_change",
      "artifact_change",
      "environment_change",
      "rollback_change",
      "external_write",
      "real_sensitive_data",
      "paid_call",
      "deployment",
      "migration",
      "irreversible_operation",
      "expiry",
    ],
  };
}

function digestForInstance(digests, lane, instance) {
  const plural = digests[`${lane}s`];
  if (plural && typeof plural === "object") return plural[instance] ?? null;
  const singular = digests[lane];
  if (singular && typeof singular === "object") return singular[instance] ?? null;
  return singular ?? null;
}

function subject(gate, digests, instance = "feature", overrides = {}) {
  return {
    policy_digest: digests.policy_digest ?? null,
    declaration_digest: digests.declaration_digest ?? null,
    intake_digest: digests.intake_digest ?? null,
    scope_digest: digests.scope_digest ?? null,
    build_digest: digests.build_digest ?? null,
    boundary_digest: gate === "G2C" ? digestForInstance(digests, "boundary_digest", instance) : null,
    slice_digest: gate === "G3" ? digestForInstance(digests, "slice_digest", instance) : null,
    engineering_digest: digests.engineering_digest ?? null,
    release_digest: digests.release_digest ?? null,
    spec_digest: digests.spec_digest ?? null,
    code_refs: [],
    artifact_refs: [],
    engineering_decision_ref: null,
    environment_ref: null,
    account_ref: null,
    rollback_ref: null,
    ...overrides,
  };
}

function decision({
  id,
  sequence,
  gate,
  instance = "feature",
  state = "passed",
  actor = { id: "Test Owner", type: "human" },
  roles,
  digests,
  evidenceRefs = [],
  subjectOverrides = {},
  authorization = emptyAuthorization(),
  decidedAt = iso(-20 + sequence / 10),
  validUntil = undefined,
  supersedes = null,
}) {
  return {
    id,
    sequence,
    gate,
    instance,
    state,
    actor,
    roles,
    decided_at: decidedAt,
    valid_until: validUntil === undefined ? (["G2", "G5"].includes(gate) ? iso(30) : null) : validUntil,
    subject: subject(gate, digests, instance, subjectOverrides),
    evidence_refs: evidenceRefs,
    authorization,
    attestation: null,
    rationale: `${gate}/${instance} regression decision`,
    supersedes,
  };
}

function evidenceRef(report, id) {
  const digest = report.digests.evidence[id];
  assert.match(digest, /^sha256:[0-9a-f]{64}$/, `missing evidence digest for ${id}`);
  return { id, digest };
}

function assignAllRoles(manifest) {
  manifest.feature.owners.role_assignments = [{ actor: "Test Owner", roles: ALL_ROLES }];
}

function configureRepositories(manifest, featureId, repositories = [NEUTRAL_REPOSITORY_ID]) {
  manifest.repositories = repositories.map((id, index) => ({
    id,
    identity: id === NEUTRAL_REPOSITORY_ID
      ? { kind: "current", name: "example-app", url: "https://example.invalid/acme/example-app.git", root: "." }
      : { kind: "external", name: id, url: `https://example.invalid/acme/${id}.git`, root: `../${id}` },
    path: "src",
    root_scope_justification: null,
    root_scope_exception_evidence_id: null,
    role: "implementation",
    baseline: {
      sha: index === 0 ? PRIMARY_SHA : SECONDARY_SHA,
      evidence_id: `EV-${featureId}-BASE-${index + 1}`,
    },
  }));
  manifest.size.repositories = repositories.length;
  if (repositories.length > 1 && manifest.size.class === "small") manifest.size.class = "medium";
  manifest.slices[0].repositories = [...repositories];
  manifest.slices[0].paths = repositories.map((repository) => ({ repository, path: "src" }));
}

function prepareThroughG2(t, {
  id,
  profile = "lite",
  target = "local_engineering",
  repositories = [NEUTRAL_REPOSITORY_ID],
  twoSlices = false,
  dataClassification = null,
} = {}) {
  const packageDir = createPackage(t, id, profile, target);
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  assignAllRoles(manifest);
  configureRepositories(manifest, id, repositories);
  if (dataClassification) manifest.classification.data = dataClassification;
  manifest.slices[0].authorization_decision_id = `DEC-${id}-003`;
  if (twoSlices) {
    manifest.slices.push({
      id: "SLC-002",
      title: "Dependent slice",
      outcome: "Verify AC-001 after SLC-001",
      depends_on: ["SLC-001"],
      boundary_ids: [],
      acceptance_criteria: ["AC-001"],
      repositories: [...repositories],
      paths: repositories.map((repository) => ({ repository, path: "src" })),
      authorization_decision_id: `DEC-${id}-003`,
    });
    manifest.size.slices = 2;
  }
  writeYaml(manifestPath, manifest);

  const evidenceEntries = manifest.repositories.map((repository, index) => evidence({
    id: repository.baseline.evidence_id,
    kind: "baseline",
    repository: repository.id,
    codeSha: repository.baseline.sha,
    baseSha: null,
  }));
  const evidencePath = join(packageDir, "evidence.yaml");
  const evidenceLedger = readYaml(evidencePath);
  evidenceLedger.entries = evidenceEntries;
  writeYaml(evidencePath, evidenceLedger);

  const inspectionResult = run(checker, ["--json", packageDir]);
  assert.equal(inspectionResult.status, 0, `${inspectionResult.stdout}\n${inspectionResult.stderr}`);
  const inspection = jsonReport(inspectionResult);
  const baselineRefs = evidenceEntries.map((entry) => evidenceRef(inspection, entry.id));
  const instances = manifest.slices.map((slice) => slice.id);
  const decisions = [
    decision({ id: `DEC-${id}-001`, sequence: 1, gate: "G0", roles: ["requirement_owner"], digests: inspection.digests }),
    decision({ id: `DEC-${id}-002`, sequence: 2, gate: "G1", roles: ["technical_owner"], digests: inspection.digests }),
    decision({
      id: `DEC-${id}-003`,
      sequence: 3,
      gate: "G2",
      roles: ["technical_owner"],
      digests: inspection.digests,
      evidenceRefs: baselineRefs,
      authorization: buildAuthorization(manifest, instances),
    }),
  ];
  const decisionsPath = join(packageDir, "decisions.yaml");
  const decisionLedger = readYaml(decisionsPath);
  decisionLedger.entries = decisions;
  writeYaml(decisionsPath, decisionLedger);
  return { packageDir, manifestPath, evidencePath, decisionsPath, manifest, evidenceLedger, decisionLedger, inspection };
}

function appendSliceAndG4Evidence(state, { includeAllRepositories = true } = {}) {
  const { manifest, evidenceLedger, evidencePath, packageDir } = state;
  const testEntries = [];
  for (const slice of manifest.slices) {
    const repositories = includeAllRepositories ? slice.repositories : slice.repositories.slice(0, 1);
    for (const repositoryId of repositories) {
      const repository = manifest.repositories.find((item) => item.id === repositoryId);
      testEntries.push(evidence({
        id: `EV-${manifest.feature.id}-TEST-${slice.id}-${repositoryId}`,
        kind: "unit_test",
        instance: slice.id,
        repository: repositoryId,
        codeSha: repository.baseline.sha,
        baseSha: repository.baseline.sha,
        acceptanceCriteria: slice.acceptance_criteria,
      }));
    }
  }
  const reviewEntries = manifest.repositories.map((repository) => evidence({
    id: `EV-${manifest.feature.id}-REVIEW-${repository.id}`,
    kind: "review",
    instance: "feature",
    repository: repository.id,
    codeSha: repository.baseline.sha,
    baseSha: repository.baseline.sha,
  }));
  evidenceLedger.entries.push(...testEntries, ...reviewEntries);
  writeYaml(evidencePath, evidenceLedger);
  const inspectionResult = run(checker, ["--json", packageDir]);
  assert.equal(inspectionResult.status, 0, `${inspectionResult.stdout}\n${inspectionResult.stderr}`);
  const inspection = jsonReport(inspectionResult);
  state.inspection = inspection;
  return { inspection, testEntries, reviewEntries };
}

function addG3AndG4Decisions(state, { omitG3For = [], codeRepositories = null } = {}) {
  const { manifest, decisionLedger, decisionsPath } = state;
  const { inspection, testEntries, reviewEntries } = appendSliceAndG4Evidence(state);
  let sequence = decisionLedger.entries.length + 1;
  for (const slice of manifest.slices) {
    if (omitG3For.includes(slice.id)) continue;
    const repositories = codeRepositories ?? slice.repositories;
    const codeRefs = repositories.map((repositoryId) => {
      const repository = manifest.repositories.find((item) => item.id === repositoryId);
      return { repository: repositoryId, sha: repository.baseline.sha, base_sha: repository.baseline.sha };
    });
    const refs = testEntries.filter((entry) => entry.subject.instance === slice.id).map((entry) => evidenceRef(inspection, entry.id));
    decisionLedger.entries.push(decision({
      id: `DEC-${manifest.feature.id}-G3-${slice.id}`,
      sequence: sequence++,
      gate: "G3",
      instance: slice.id,
      roles: ["verifier"],
      digests: inspection.digests,
      evidenceRefs: refs,
      subjectOverrides: { code_refs: codeRefs },
    }));
  }
  const codeRefs = manifest.repositories.map((repository) => ({ repository: repository.id, sha: repository.baseline.sha, base_sha: repository.baseline.sha }));
  decisionLedger.entries.push(decision({
    id: `DEC-${manifest.feature.id}-G4`,
    sequence,
    gate: "G4",
    roles: ["reviewer"],
    digests: inspection.digests,
    evidenceRefs: [...testEntries, ...reviewEntries].map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: { code_refs: codeRefs },
  }));
  writeYaml(decisionsPath, decisionLedger);
  return { inspection, testEntries, reviewEntries };
}

function prepareThroughG4(t, options) {
  const state = prepareThroughG2(t, options);
  addG3AndG4Decisions(state);
  const g4 = run(checker, ["--gate", "G4", "--json", state.packageDir]);
  const g2Debug = g4.status === 0 ? null : run(checker, ["--gate", "G2", "--json", state.packageDir]);
  const g3Debug = g4.status === 0 ? null : run(checker, ["--gate", "G3", "--instance", "SLC-001", "--json", state.packageDir]);
  assert.equal(g4.status, 0, `${g4.stdout}\n${g4.stderr}\nG2:\n${g2Debug?.stdout ?? ""}${g2Debug?.stderr ?? ""}\nG3:\n${g3Debug?.stdout ?? ""}${g3Debug?.stderr ?? ""}`);
  assert.equal(jsonReport(g4).gates[0].state, "passed");
  return state;
}

function assertRejected(result, pattern, message = "expected fail-closed result") {
  assert.notEqual(result.status, 0, `${message}\n${result.stdout}\n${result.stderr}`);
  const report = jsonReport(result);
  const text = JSON.stringify({ errors: report.errors, gates: report.gates });
  if (pattern) assert.match(text, pattern);
  return report;
}

test("generator physically tailors artifacts by Profile and Target", (t) => {
  const lite = createPackage(t, "FEAT-901", "lite", "local_engineering");
  fillMarkdownTokens(lite);
  assert.equal(existsSync(join(lite, "03-decisions-and-risks.md")), false);
  assert.equal(existsSync(join(lite, "04-contract-change-plan.md")), false);
  assert.equal(existsSync(join(lite, "05-technical-design.md")), false);
  assert.equal(existsSync(join(lite, "09-release-and-rollback.md")), false);
  assert.equal(existsSync(join(lite, "10-delivery-summary.md")), false);
  assert.equal(run(checker, [lite]).status, 0);

  const staging = createPackage(t, "FEAT-902", "standard", "staging");
  fillMarkdownTokens(staging);
  assert.equal(existsSync(join(staging, "03-decisions-and-risks.md")), true);
  assert.equal(existsSync(join(staging, "05-technical-design.md")), true);
  assert.equal(existsSync(join(staging, "09-release-and-rollback.md")), true);
  assert.equal(existsSync(join(staging, "04-contract-change-plan.md")), false);
  assert.equal(run(checker, [staging]).status, 0);
});

test("generator binds current identity to project config and fails without config", (t) => {
  const foreignRoot = mkdtempSync(join(tmpdir(), "codex-feature-delivery-foreign-"));
  const nonGitRoot = mkdtempSync(join(tmpdir(), "codex-feature-delivery-nongit-"));
  t.after(() => rmSync(foreignRoot, { recursive: true, force: true }));
  t.after(() => rmSync(nonGitRoot, { recursive: true, force: true }));
  assert.equal(run("git", ["init", "-q", foreignRoot]).status, 0);

  const packageDir = createPackage(t, "FEAT-CONFIG-IDENTITY", "lite", "local_engineering", { slug: "configured-identity" });
  const manifest = readYaml(join(packageDir, "feature.yaml"));
  assert.equal(manifest.repositories[0].id, NEUTRAL_REPOSITORY_ID);
  assert.deepEqual(manifest.repositories[0].identity, {
    kind: "current",
    name: "example-app",
    url: "https://example.invalid/acme/example-app.git",
    root: ".",
  });
  assert.deepEqual(manifest.slices[0].repositories, [NEUTRAL_REPOSITORY_ID]);
  const checked = run(checker, ["--json", packageDir], { cwd: project.root });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);

  const noConfig = run(newFeature, [
    "FEAT-NOCONFIG-001", "no-config", "--profile", "lite", "--target", "local_engineering",
    "--owner", "Test Owner", "--scope", "src/app",
  ], { cwd: foreignRoot });
  assert.equal(noConfig.status, 2, `${noConfig.stdout}\n${noConfig.stderr}`);
  assert.match(`${noConfig.stdout}\n${noConfig.stderr}`, /项目配置|\.feature-delivery\.yaml|不存在/i);

  const rejected = run(newFeature, [
    "FEAT-NONGIT-001",
    "non-git",
    "--profile",
    "lite",
    "--target",
    "local_engineering",
    "--owner",
    "Test Owner",
    "--scope",
    "src/app",
  ], { cwd: nonGitRoot });
  assert.equal(rejected.status, 2, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Git worktree/i);
  assert.equal(existsSync(join(nonGitRoot, "work-items/features/FEAT-NONGIT-001-non-git")), false);
});

test("JSON Schema rejects undeclared fields", (t) => {
  const packageDir = createPackage(t, "FEAT-903");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.feature.rogue_control = "must not be ignored";
  writeYaml(manifestPath, manifest);
  assertRejected(run(checker, ["--json", packageDir]), /rogue_control|额外|additional/i);
});

test("core artifacts cannot alias one physical file", (t) => {
  const packageDir = createPackage(t, "FEAT-904");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  const requirements = manifest.artifacts.find((artifact) => artifact.kind === "requirements");
  requirements.path = "00-feature-brief.md";
  writeYaml(manifestPath, manifest);
  assertRejected(run(checker, ["--json", packageDir]), /artifact|path|路径|重复|alias/i);
});

test("G0 ignores unresolved tokens in later-phase templates", (t) => {
  const packageDir = createPackage(t, "FEAT-905");
  fillMarkdownTokens(packageDir, ["00-feature-brief.md"]);
  assert.match(readFileSync(join(packageDir, "01-requirements.md"), "utf8"), /\{\{[A-Z0-9_]+\}\}/);
  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(ledgerPath);
  ledger.entries = [decision({ id: "DEC-FEAT-905-001", sequence: 1, gate: "G0", roles: ["requirement_owner"], digests: inspection.digests })];
  writeYaml(ledgerPath, ledger);
  const g0 = run(checker, ["--gate", "G0", "--json", packageDir]);
  assert.equal(g0.status, 0, `${g0.stdout}\n${g0.stderr}`);
  assert.equal(jsonReport(g0).gates[0].state, "passed");
});

test("an unassigned actor cannot self-assert an approval role", (t) => {
  const packageDir = createPackage(t, "FEAT-906");
  fillMarkdownTokens(packageDir);
  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(ledgerPath);
  ledger.entries = [decision({
    id: "DEC-FEAT-906-001",
    sequence: 1,
    gate: "G0",
    actor: { id: "Mallory", type: "human" },
    roles: ["requirement_owner"],
    digests: inspection.digests,
  })];
  writeYaml(ledgerPath, ledger);
  assertRejected(run(checker, ["--gate", "G0", "--json", packageDir]), /actor|role|角色|分配|Mallory/i);
});

test("Codex cannot approve its own Gate", (t) => {
  const packageDir = createPackage(t, "FEAT-907");
  fillMarkdownTokens(packageDir);
  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(ledgerPath);
  ledger.entries = [decision({
    id: "DEC-FEAT-907-001",
    sequence: 1,
    gate: "G0",
    actor: { id: "Test Owner", type: "codex" },
    roles: ["requirement_owner"],
    digests: inspection.digests,
  })];
  writeYaml(ledgerPath, ledger);
  assertRejected(run(checker, ["--gate", "G0", "--json", packageDir]), /human|actor|codex|人工/i);
});

test("a human label is only a draft until an external key signs the exact Decision", (t) => {
  const packageDir = createPackage(t, "FEAT-947");
  fillMarkdownTokens(packageDir, ["00-feature-brief.md"]);
  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(ledgerPath);
  ledger.entries = [decision({
    id: "DEC-FEAT-947-001",
    sequence: 1,
    gate: "G0",
    roles: ["requirement_owner"],
    digests: inspection.digests,
  })];
  // Deliberately bypass writeYaml's test signer: actor/type/roles are still only self-reported YAML.
  writeFileSync(ledgerPath, YAML.stringify(ledger, { lineWidth: 0 }));
  assertRejected(run(checker, ["--gate", "G0", "--json", packageDir]), /attestation|approval|签名|信任根/i);

  const signed = run(process.execPath, [
    signDecisionScript,
    packageDir,
    "DEC-FEAT-947-001",
    "--key-id",
    "test-owner-key",
    "--private-key",
    testApprovalPrivateKeyPath,
    "--trust-root",
    testTrustRoot,
  ]);
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
  const passed = run(checker, ["--gate", "G0", "--json", packageDir]);
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);

  const tampered = readYaml(ledgerPath);
  tampered.entries[0].rationale = "tampered after approval";
  writeFileSync(ledgerPath, YAML.stringify(tampered, { lineWidth: 0 }));
  assertRejected(run(checker, ["--gate", "G0", "--json", packageDir]), /payload_digest|签名|attestation|decision/i);
});

test("approval private keys cannot be initialized inside a Git worktree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-feature-delivery-key-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(run("git", ["-C", root, "init", "-q"]).status, 0);
  const trustRoot = join(root, "approval-trust.yaml");
  const privateKey = join(root, "approval-private.pem");
  writeFileSync(trustRoot, "schema_version: 1\nkind: FeatureDeliveryApprovalTrust\nkeys: []\n");
  const result = run(process.execPath, [
    initApproverKeyScript,
    "--actor", "Test Owner",
    "--key-id", "forbidden-worktree-key",
    "--private-key", privateKey,
    "--trust-root", trustRoot,
    "--role", "reviewer",
    "--gate", "G4",
    "--profile", "standard",
    "--target", "local_engineering",
    "--valid-until", iso(60 * 24 * 365),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Git worktree|private key/i);
  assert.equal(existsSync(privateKey), false);
});

test("every historical passed Decision remains signed and its Evidence refs immutable", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-949" });
  const inspection = jsonReport(run(checker, ["--json", state.packageDir]));
  const previous = state.decisionLedger.entries.find((entry) => entry.gate === "G0");
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-949-004",
    sequence: 4,
    gate: "G0",
    roles: ["requirement_owner"],
    digests: inspection.digests,
    supersedes: previous.id,
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  assert.equal(run(checker, ["--gate", "G2", "--json", state.packageDir]).status, 0);

  const tampered = readYaml(state.decisionsPath);
  tampered.entries.find((entry) => entry.id === previous.id).rationale = "rewritten historical approval";
  writeFileSync(state.decisionsPath, YAML.stringify(tampered, { lineWidth: 0 }));
  assertRejected(run(checker, ["--json", state.packageDir]), /历史 passed Decision|attestation|payload_digest|验签/i);
});

test("manifest and Decisions bind the exact gate policy bytes", (t) => {
  const packageDir = createPackage(t, "FEAT-950");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.policy.digest = `sha256:${"0".repeat(64)}`;
  writeYaml(manifestPath, manifest);
  assertRejected(run(checker, ["--json", packageDir]), /policy\.digest|gate-policy\.yaml|精确绑定/i);
});

test("risk factors are a closed escalation vocabulary", (t) => {
  const packageDir = createPackage(t, "FEAT-951");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.classification.risk_factors = ["database-migration"];
  writeYaml(manifestPath, manifest);
  assertRejected(run(checker, ["--json", packageDir]), /risk_factors|database-migration|enum|允许值/i);
});

test("a G2 approval becomes stale when the repository baseline drifts", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-908" });
  const before = run(checker, ["--gate", "G2", "--json", state.packageDir]);
  assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`);
  const manifest = readYaml(state.manifestPath);
  manifest.repositories[0].baseline.sha = DRIFT_SHA;
  writeYaml(state.manifestPath, manifest);
  const report = assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /baseline|build_digest|摘要|不一致|漂移/i);
  assert.notEqual(report.gates[0].state, "passed");
  assertRejected(run(checker, ["--json", state.packageDir]), /baseline|build_digest|stale|不一致|漂移/i, "CI/default validation must reject a stale recorded approval");
});

test("G2 never authorizes a real external account", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-G2-ACCOUNT" });
  const ledger = readYaml(state.decisionsPath);
  ledger.entries.find((entry) => entry.gate === "G2").authorization.account = "production-account";
  writeYaml(state.decisionsPath, ledger);
  assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /G2.*account.*null|真实目标账号/i);
});

test("a G4 approval becomes stale when its verification report changes", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-948" });
  const verificationPath = join(state.packageDir, "08-verification-report.md");
  writeFileSync(verificationPath, `${readFileSync(verificationPath, "utf8")}\nPost-approval verification edit.\n`);
  assertRejected(
    run(checker, ["--gate", "G4", "--json", state.packageDir]),
    /engineering_digest|verification|摘要|不一致|漂移/i,
  );
});

test("resolved and waived dependencies require successful typed evidence", (t) => {
  const packageDir = createPackage(t, "FEAT-909");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.dependencies = [{ id: "DEP-1", type: "service", status: "resolved", owner: "Test Owner", evidence_id: "EV-MISSING" }];
  writeYaml(manifestPath, manifest);
  const plain = run(checker, ["--json", packageDir]);
  const g2 = run(checker, ["--gate", "G2", "--json", packageDir]);
  assert.ok(plain.status !== 0 || g2.status !== 0);
  const text = `${plain.stdout}${plain.stderr}${g2.stdout}${g2.stderr}`;
  assert.match(text, /DEP-1|EV-MISSING|dependency|依赖|Evidence/i);
});

test("a Slice waits for every depends_on Slice G3", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-910", twoSlices: true });
  addG3AndG4Decisions(state, { omitG3For: ["SLC-001"] });
  const result = run(checker, ["--gate", "G3", "--instance", "SLC-002", "--json", state.packageDir]);
  const report = assertRejected(result, /SLC-001|depends|依赖|前置/i);
  assert.notEqual(report.gates[0].state, "passed");
});

test("unrelated Boundary and Slice digest lanes remain isolated", (t) => {
  const packageDir = createPackage(t, "FEAT-926", "standard");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.size.class = "medium";
  manifest.size.boundaries = 2;
  manifest.size.slices = 2;
  manifest.boundaries = ["BND-001", "BND-002"].map((id) => ({
    id,
    type: "handwritten_protocol",
    impact: "additive",
    owner: "Test Owner",
    authority: `contracts/${id}.yaml`,
    producers: [NEUTRAL_REPOSITORY_ID],
    consumers: [],
    known_unknowns: [],
    artifact_id: `ART-BOUNDARY-${id}`,
  }));
  manifest.slices[0].boundary_ids = ["BND-001"];
  manifest.slices.push({
    id: "SLC-002",
    title: "Second boundary slice",
    outcome: "Exercise BND-002",
    depends_on: [],
    boundary_ids: ["BND-002"],
    acceptance_criteria: ["AC-001"],
    repositories: [NEUTRAL_REPOSITORY_ID],
    paths: [{ repository: NEUTRAL_REPOSITORY_ID, path: "src" }],
    authorization_decision_id: null,
  });
  const contract = manifest.artifacts.find((item) => item.kind === "contract_change_plan");
  contract.applicability = "required";
  contract.reason = "boundaries_present";
  manifest.artifacts.push(...manifest.boundaries.map((boundary) => ({
    id: boundary.artifact_id,
    kind: "boundary_spec",
    path: `boundaries/${boundary.id}.md`,
    authority: "normative",
    applicability: "required",
    reason: `boundary_${boundary.id}`,
  })));
  mkdirSync(join(packageDir, "boundaries"));
  writeFileSync(join(packageDir, "04-contract-change-plan.md"), "Boundary index complete\n");
  writeFileSync(join(packageDir, "boundaries/BND-001.md"), "BND-001 v1\n");
  writeFileSync(join(packageDir, "boundaries/BND-002.md"), "BND-002 v1\n");
  writeYaml(manifestPath, manifest);
  const before = jsonReport(run(checker, ["--json", packageDir]));
  writeFileSync(join(packageDir, "boundaries/BND-002.md"), "BND-002 v2\n");
  const after = jsonReport(run(checker, ["--json", packageDir]));
  assert.equal(after.digests.boundary_digests["BND-001"], before.digests.boundary_digests["BND-001"]);
  assert.notEqual(after.digests.boundary_digests["BND-002"], before.digests.boundary_digests["BND-002"]);
  assert.equal(after.digests.slice_digests["SLC-001"], before.digests.slice_digests["SLC-001"]);
  assert.notEqual(after.digests.slice_digests["SLC-002"], before.digests.slice_digests["SLC-002"]);
});

test("Boundary materializer creates an independent spec and derived index atomically", (t) => {
  const packageDir = createPackage(t, "FEAT-927", "standard");
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.size.class = "medium";
  manifest.size.boundaries = 1;
  manifest.boundaries = [{
    id: "BND-001",
    type: "handwritten_protocol",
    impact: "additive",
    owner: "Test Owner",
    authority: "contracts/task.yaml",
    producers: [NEUTRAL_REPOSITORY_ID],
    consumers: [],
    known_unknowns: [],
    artifact_id: "ART-BOUNDARY-BND-001",
  }];
  manifest.slices[0].boundary_ids = ["BND-001"];
  writeYaml(manifestPath, manifest);
  const lockPath = join(packageDir, ".cfd-materialize.lock");
  const manifestBeforeLockAttempt = readFileSync(manifestPath, "utf8");
  writeFileSync(lockPath, "held by concurrent writer\n", { flag: "wx", mode: 0o600 });
  const locked = run(process.execPath, [boundaryMaterializer, packageDir, "BND-001"]);
  assert.notEqual(locked.status, 0);
  assert.match(`${locked.stdout}\n${locked.stderr}`, /lock|正在执行|materialize/i);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBeforeLockAttempt);
  assert.equal(existsSync(join(packageDir, "boundaries/BND-001.md")), false);
  unlinkSync(lockPath);
  const created = run(process.execPath, [boundaryMaterializer, packageDir, "BND-001"]);
  assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
  const updated = readYaml(manifestPath);
  const artifact = updated.artifacts.find((item) => item.id === "ART-BOUNDARY-BND-001");
  assert.deepEqual({ kind: artifact.kind, path: artifact.path, authority: artifact.authority, applicability: artifact.applicability }, {
    kind: "boundary_spec",
    path: "boundaries/BND-001.md",
    authority: "normative",
    applicability: "required",
  });
  assert.equal(existsSync(join(packageDir, artifact.path)), true);
  assert.doesNotMatch(readFileSync(join(packageDir, "04-contract-change-plan.md"), "utf8"), /\{\{BOUNDARY_INDEX_ROWS\}\}/);
  assert.equal(run(checker, ["--json", packageDir]).status, 0);
  assertRejected(run(checker, ["--gate", "G2C", "--instance", "BND-001", "--json", packageDir]), /G2|boundary|模板变量|Evidence/i);
});

test("unknown Gate instances are rejected, including plausible IDs", (t) => {
  const packageDir = createPackage(t, "FEAT-911");
  fillMarkdownTokens(packageDir);
  const direct = assertRejected(run(checker, ["--gate", "G3", "--instance", "SLC-999", "--json", packageDir]), /不存在|unknown|instance/i);
  assert.equal(direct.gates[0].state, "failed");

  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(ledgerPath);
  ledger.entries = [decision({
    id: "DEC-FEAT-911-001",
    sequence: 1,
    gate: "G3",
    instance: "SLC-999",
    roles: ["verifier"],
    digests: inspection.digests,
    subjectOverrides: { code_refs: [{ repository: NEUTRAL_REPOSITORY_ID, sha: PRIMARY_SHA, base_sha: PRIMARY_SHA }] },
  })];
  writeYaml(ledgerPath, ledger);
  assertRejected(run(checker, ["--json", packageDir]), /SLC-999|instance|不存在/i);
});

test("lifecycle=completed cannot bypass terminal closure in evaluator or batch CI", (t) => {
  const featureRoot = project.featureDir;
  const packageDir = createPackage(t, "FEAT-912", "lite", "local_engineering", { root: featureRoot });
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.feature.lifecycle = "completed";
  writeYaml(manifestPath, manifest);

  assertRejected(run(checker, ["--json", packageDir]), /completed|terminal|G4|summary|完成|闭合/i);

  for (const name of readFileSync(legacyAllowlist, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))) {
    const legacyDir = join(featureRoot, name);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "feature.yaml"), "schema_version: 1\n");
  }
  const batch = run(process.execPath, [checkAll, "--project-config", project.configPath, "--repository-root", project.root, "--feature-root", featureRoot]);
  assert.notEqual(batch.status, 0, `${batch.stdout}\n${batch.stderr}`);
  assert.match(`${batch.stdout}${batch.stderr}`, /FEAT-912-evaluator-test/);
});

test("lifecycle=active requires a current G2 build authorization", (t) => {
  const packageDir = createPackage(t, "FEAT-924");
  fillMarkdownTokens(packageDir);
  const manifestPath = join(packageDir, "feature.yaml");
  const manifest = readYaml(manifestPath);
  manifest.feature.lifecycle = "active";
  writeYaml(manifestPath, manifest);
  assertRejected(run(checker, ["--json", packageDir]), /G2|authorization|active|批准|授权/i);
});

test("batch validation rejects duplicate Feature IDs", (t) => {
  const featureRoot = project.featureDir;
  const first = createPackage(t, "FEAT-953", "lite", "local_engineering", { root: featureRoot, slug: "first" });
  const second = createPackage(t, "FEAT-953", "lite", "local_engineering", { root: featureRoot, slug: "second" });
  fillMarkdownTokens(first);
  fillMarkdownTokens(second);
  const batch = run(process.execPath, [checkAll, "--project-config", project.configPath, "--repository-root", project.root, "--feature-root", featureRoot]);
  assert.notEqual(batch.status, 0, `${batch.stdout}\n${batch.stderr}`);
  assert.match(`${batch.stdout}${batch.stderr}`, /重复 feature\.id=FEAT-953|duplicate/i);
});

test("decision time cannot precede the evidence it approves", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-913" });
  const ledger = readYaml(state.decisionsPath);
  const g2 = ledger.entries.find((entry) => entry.gate === "G2");
  g2.decided_at = iso(-120);
  g2.valid_until = iso(30);
  writeYaml(state.decisionsPath, ledger);
  assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /decided_at|Evidence|evidence|早于|时间/i);
});

test("G3 code_refs cover every Slice repository", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-914", profile: "standard", repositories: [NEUTRAL_REPOSITORY_ID, "secondary"] });
  addG3AndG4Decisions(state, { codeRepositories: [NEUTRAL_REPOSITORY_ID] });
  const result = run(checker, ["--gate", "G3", "--instance", "SLC-001", "--json", state.packageDir]);
  assertRejected(result, /secondary|code_ref|repository|覆盖/i);
});

test("controlled Profile adds executable evidence controls", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-925", profile: "controlled" });
  addG3AndG4Decisions(state);
  assertRejected(run(checker, ["--gate", "G3", "--instance", "SLC-001", "--json", state.packageDir]), /static_analysis|controlled|Evidence/i);
});

test("G4 final code refs require tests on the same repository code and base", (t) => {
  const state = prepareThroughG2(t, { id: "FEAT-952" });
  const { testEntries, reviewEntries } = appendSliceAndG4Evidence(state);
  for (const review of reviewEntries) {
    const stored = state.evidenceLedger.entries.find((entry) => entry.id === review.id);
    stored.subject.code_sha = DRIFT_SHA;
    stored.subject.base_sha = PRIMARY_SHA;
  }
  writeYaml(state.evidencePath, state.evidenceLedger);
  const inspection = jsonReport(run(checker, ["--json", state.packageDir]));
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-952-G3-SLC-001",
    sequence: 4,
    gate: "G3",
    instance: "SLC-001",
    roles: ["verifier"],
    digests: inspection.digests,
    evidenceRefs: testEntries.map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: { code_refs: [{ repository: NEUTRAL_REPOSITORY_ID, sha: PRIMARY_SHA, base_sha: PRIMARY_SHA }] },
  }));
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-952-G4",
    sequence: 5,
    gate: "G4",
    roles: ["reviewer"],
    digests: inspection.digests,
    evidenceRefs: [...testEntries, ...reviewEntries].map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: { code_refs: [{ repository: NEUTRAL_REPOSITORY_ID, sha: DRIFT_SHA, base_sha: PRIMARY_SHA }] },
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  assertRejected(run(checker, ["--gate", "G4", "--json", state.packageDir]), /最终测试 Evidence|逐仓精确绑定|code_ref/i);
});

test("repository identity and authorization scopes fail closed", async (t) => {
  await t.test("repository path traversal is rejected", () => {
    const packageDir = createPackage(t, "FEAT-930");
    fillMarkdownTokens(packageDir);
    const manifestPath = join(packageDir, "feature.yaml");
    const manifest = readYaml(manifestPath);
    manifest.repositories[0].path = "../escape";
    writeYaml(manifestPath, manifest);
    assertRejected(run(checker, ["--json", packageDir]), /repository|path|相对|pattern|越出/i);
  });

  await t.test("managed repository identity must match the configured repository registry", () => {
    const packageDir = createPackage(t, "FEAT-931");
    fillMarkdownTokens(packageDir);
    const manifestPath = join(packageDir, "feature.yaml");
    const manifest = readYaml(manifestPath);
    manifest.repositories[0].identity = { kind: "managed", name: "managed-lib", url: "https://example.invalid/spoof.git", root: "components/managed-lib" };
    writeYaml(manifestPath, manifest);
    assertRejected(run(checker, ["--json", packageDir]), /repository registry|managed identity|精确一致/i);
  });

  await t.test("G2 paths must exactly match Slice repository/path scopes", () => {
    const state = prepareThroughG2(t, { id: "FEAT-932" });
    const ledger = readYaml(state.decisionsPath);
    const g2 = ledger.entries.find((entry) => entry.gate === "G2");
    g2.authorization.paths = [{ repository: NEUTRAL_REPOSITORY_ID, path: "src/unplanned" }];
    writeYaml(state.decisionsPath, ledger);
    assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /authorization\.paths|Slice scope|精确覆盖/i);
  });

  await t.test("free-text capability synonyms are rejected", () => {
    const state = prepareThroughG2(t, { id: "FEAT-933" });
    const ledger = readYaml(state.decisionsPath);
    const g2 = ledger.entries.find((entry) => entry.gate === "G2");
    g2.authorization.allowed_actions.push("write_files");
    writeYaml(state.decisionsPath, ledger);
    assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /allowed_actions|capability|枚举|enum/i);
  });

  await t.test("controlled whole-repository scope requires an explicit exception Evidence", () => {
    const state = prepareThroughG2(t, { id: "FEAT-934", profile: "controlled" });
    const manifest = readYaml(state.manifestPath);
    manifest.repositories[0].path = ".";
    manifest.repositories[0].root_scope_justification = "Whole repository change is required";
    manifest.slices[0].paths = [{ repository: NEUTRAL_REPOSITORY_ID, path: "." }];
    writeYaml(state.manifestPath, manifest);
    assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /exception Evidence|整仓 scope|controlled/i);
  });
});

test("Package root symlinks are rejected before parsing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-feature-delivery-root-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = createPackage(t, "FEAT-935", "lite", "local_engineering", { root });
  const linkedRoot = join(root, "FEAT-935-linked-root");
  symlinkSync(packageDir, linkedRoot, "dir");
  assertRejected(run(checker, ["--repository-root", project.root, "--project-config", project.configPath, "--json", linkedRoot]), /根目录|符号链接|symlink/i);
});

test("every Decision timestamp and Evidence retention window is validated", async (t) => {
  await t.test("a non-passed future Decision is structurally invalid", () => {
    const packageDir = createPackage(t, "FEAT-936");
    fillMarkdownTokens(packageDir);
    const inspection = jsonReport(run(checker, ["--json", packageDir]));
    const ledgerPath = join(packageDir, "decisions.yaml");
    const ledger = readYaml(ledgerPath);
    ledger.entries = [decision({ id: "DEC-FEAT-936-001", sequence: 1, gate: "G0", state: "blocked", roles: ["requirement_owner"], digests: inspection.digests, decidedAt: iso(60) })];
    writeYaml(ledgerPath, ledger);
    assertRejected(run(checker, ["--json", packageDir]), /decided_at|未来/i);
  });

  await t.test("valid_until must be later than decided_at for every state", () => {
    const packageDir = createPackage(t, "FEAT-937");
    fillMarkdownTokens(packageDir);
    const inspection = jsonReport(run(checker, ["--json", packageDir]));
    const ledgerPath = join(packageDir, "decisions.yaml");
    const ledger = readYaml(ledgerPath);
    ledger.entries = [decision({ id: "DEC-FEAT-937-001", sequence: 1, gate: "G0", state: "failed", roles: ["requirement_owner"], digests: inspection.digests, decidedAt: iso(-10), validUntil: iso(-20) })];
    writeYaml(ledgerPath, ledger);
    assertRejected(run(checker, ["--json", packageDir]), /valid_until.*decided_at|晚于/i);
  });

  await t.test("passed Evidence retention must cover Decision valid_until", () => {
    const state = prepareThroughG2(t, { id: "FEAT-938" });
    const evidenceLedger = readYaml(state.evidencePath);
    evidenceLedger.entries[0].artifacts[0].retention_until = iso(10);
    writeYaml(state.evidencePath, evidenceLedger);
    assertRejected(run(checker, ["--gate", "G2", "--json", state.packageDir]), /保留期|retention|有效窗口/i);
  });
});

test("controlled code-scoped controls bind every repository code_sha and base_sha", (t) => {
  const state = prepareThroughG2(t, {
    id: "FEAT-939",
    profile: "controlled",
    repositories: [NEUTRAL_REPOSITORY_ID, "secondary"],
    dataClassification: "restricted",
  });
  const { testEntries, reviewEntries } = appendSliceAndG4Evidence(state);
  const slice = state.manifest.slices[0];
  const staticEntries = state.manifest.repositories.map((repository) => evidence({
    id: `EV-FEAT-939-STATIC-${repository.id}`,
    kind: "static_analysis",
    instance: slice.id,
    repository: repository.id,
    codeSha: repository.baseline.sha,
    baseSha: repository.baseline.sha,
  }));
  const securityEntries = state.manifest.repositories.map((repository, index) => evidence({
    id: `EV-FEAT-939-SECURITY-${repository.id}`,
    kind: "security_review",
    instance: "feature",
    repository: repository.id,
    codeSha: repository.baseline.sha,
    baseSha: index === 0 ? repository.baseline.sha : DRIFT_SHA,
  }));
  const dataEntries = state.manifest.repositories.map((repository, index) => evidence({
    id: `EV-FEAT-939-DATA-${repository.id}`,
    kind: "data_review",
    instance: "feature",
    repository: repository.id,
    codeSha: repository.baseline.sha,
    baseSha: index === 0 ? repository.baseline.sha : DRIFT_SHA,
  }));
  state.evidenceLedger.entries.push(...staticEntries, ...securityEntries, ...dataEntries);
  writeYaml(state.evidencePath, state.evidenceLedger);
  const inspectionResult = run(checker, ["--json", state.packageDir]);
  assert.equal(inspectionResult.status, 0, `${inspectionResult.stdout}\n${inspectionResult.stderr}`);
  const inspection = jsonReport(inspectionResult);
  const codeRefs = state.manifest.repositories.map((repository) => ({ repository: repository.id, sha: repository.baseline.sha, base_sha: repository.baseline.sha }));
  let sequence = state.decisionLedger.entries.length + 1;
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-939-G3",
    sequence: sequence++,
    gate: "G3",
    instance: slice.id,
    roles: ["verifier"],
    digests: inspection.digests,
    evidenceRefs: [...testEntries, ...staticEntries].map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: { code_refs: codeRefs },
  }));
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-939-G4",
    sequence,
    gate: "G4",
    roles: ["reviewer"],
    digests: inspection.digests,
    evidenceRefs: [...testEntries, ...reviewEntries, ...securityEntries, ...dataEntries].map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: { code_refs: codeRefs },
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  const report = assertRejected(run(checker, ["--gate", "G4", "--json", state.packageDir]), /base_sha|逐仓|security_review|data_review/i);
  const reasons = JSON.stringify(report.gates);
  assert.match(reasons, /security_review/);
  assert.match(reasons, /data_review/);
});

test("future and reversed Evidence timelines are structurally invalid", async (t) => {
  await t.test("future recorded_at", () => {
    const packageDir = createPackage(t, "FEAT-915");
    fillMarkdownTokens(packageDir);
    const ledgerPath = join(packageDir, "evidence.yaml");
    const ledger = readYaml(ledgerPath);
    ledger.entries = [evidence({ id: "EV-FEAT-915-001", kind: "baseline", recordedAt: iso(60), startedAt: iso(-2), finishedAt: iso(-1) })];
    writeYaml(ledgerPath, ledger);
    assertRejected(run(checker, ["--json", packageDir]), /recorded_at|future|未来/i);
  });

  await t.test("finished_at before started_at", () => {
    const packageDir = createPackage(t, "FEAT-916");
    fillMarkdownTokens(packageDir);
    const ledgerPath = join(packageDir, "evidence.yaml");
    const ledger = readYaml(ledgerPath);
    ledger.entries = [evidence({ id: "EV-FEAT-916-001", kind: "baseline", recordedAt: iso(-10), startedAt: iso(-5), finishedAt: iso(-6) })];
    writeYaml(ledgerPath, ledger);
    assertRejected(run(checker, ["--json", packageDir]), /started_at|finished_at|顺序|早于|时间/i);
  });
});

test("production evidence cannot be recycled from local", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-917", profile: "standard", target: "production" });
  const releaseArtifact = evidence({ id: "EV-FEAT-917-REL", kind: "release_artifact", environment: "local" });
  const rollback = evidence({ id: "EV-FEAT-917-RBK", kind: "rollback_rehearsal", environment: "local" });
  state.evidenceLedger.entries.push(releaseArtifact, rollback);
  writeYaml(state.evidencePath, state.evidenceLedger);
  const inspection = jsonReport(run(checker, ["--json", state.packageDir]));
  const sequence = state.decisionLedger.entries.length + 1;
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-917-G5",
    sequence,
    gate: "G5",
    roles: ["release_owner"],
    digests: inspection.digests,
    evidenceRefs: [evidenceRef(inspection, releaseArtifact.id), evidenceRef(inspection, rollback.id)],
    subjectOverrides: {
      artifact_refs: [{ id: "release", digest: releaseArtifact.artifacts[0].digest }],
      environment_ref: "production",
      rollback_ref: rollback.id,
    },
    authorization: buildAuthorization(state.manifest, ["production-release"], "production"),
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  assertRejected(run(checker, ["--gate", "G5", "--json", state.packageDir]), /environment|production|local|环境/i);
});

test("Delivery Summary is machine-bound and rejects tampering", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-918" });
  const materialized = run(process.execPath, [materializer, state.packageDir]);
  assert.equal(materialized.status, 0, `${materialized.stdout}\n${materialized.stderr}`);
  fillMarkdownTokens(state.packageDir);
  const before = run(checker, ["--strict", "--json", state.packageDir]);
  assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`);

  const summaryPath = join(state.packageDir, "10-delivery-summary.md");
  const originalSummary = readFileSync(summaryPath, "utf8");
  writeFileSync(summaryPath, `${originalSummary}\n已发布到另一个未验证环境。\n`);
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /summary|body|正文|摘要|改写/i);

  const prefix = originalSummary.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/)?.[0];
  assert.ok(prefix, "generated Summary must have frontmatter");
  const forgedBody = `${originalSummary.slice(prefix.length)}\n伪造但重新计算了自报 hash。\n`;
  const forgedPrefix = prefix.replace(/summary_body_digest:\s*sha256:[0-9a-f]{64}/, `summary_body_digest: ${sha256(forgedBody)}`);
  writeFileSync(summaryPath, `${forgedPrefix}${forgedBody}`);
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /canonical|重建|manifest|ledger/i);

  writeFileSync(summaryPath, originalSummary.replace(/^---\r?\n/, "---\nunexpected_field: forbidden\n"));
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /frontmatter|字段|unexpected/i);

  let summary = originalSummary;
  if (/terminal_decision_id:\s*[^\n]+/.test(summary)) {
    summary = summary.replace(/terminal_decision_id:\s*[^\n]+/, "terminal_decision_id: DEC-TAMPERED");
  } else {
    summary = `---\nschema_version: 2\nkind: DeliverySummary\nfeature_id: FEAT-918\nterminal_decision_id: DEC-TAMPERED\n---\n${summary}`;
  }
  writeFileSync(summaryPath, summary);
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /summary|terminal_decision_id|tamper|篡改|摘要/i);

  writeFileSync(summaryPath, originalSummary);
  const decisionLedger = readYaml(state.decisionsPath);
  decisionLedger.entries.find((entry) => entry.gate === "G4").rationale = "Changed terminal rationale after materialization";
  writeYaml(state.decisionsPath, decisionLedger);
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /terminal_decision_digest|Decision record digest|canonical|重建/i);
});

test("policy-derived not_applicable Gates reject every ledger Decision", (t) => {
  const packageDir = createPackage(t, "FEAT-928");
  fillMarkdownTokens(packageDir);
  const inspection = jsonReport(run(checker, ["--json", packageDir]));
  const decisionsPath = join(packageDir, "decisions.yaml");
  const ledger = readYaml(decisionsPath);
  ledger.entries = [decision({
    id: "DEC-FEAT-928-G5",
    sequence: 1,
    gate: "G5",
    state: "blocked",
    roles: ["release_owner"],
    digests: inspection.digests,
  })];
  writeYaml(decisionsPath, ledger);
  assertRejected(run(checker, ["--json", packageDir]), /not_applicable|不得存在任何|G5|policy/i);
});

test("managed core, artifact, and Summary files reject hardlinks", async (t) => {
  await t.test("core YAML with an external hardlink", () => {
    const packageDir = createPackage(t, "FEAT-929");
    fillMarkdownTokens(packageDir);
    linkSync(join(packageDir, "evidence.yaml"), join(dirname(packageDir), "evidence-hardlink.yaml"));
    assertRejected(run(checker, ["--json", packageDir]), /hardlink|nlink|独占文件|dev\+ino/i);
  });

  await t.test("two managed artifact paths with one inode", () => {
    const packageDir = createPackage(t, "FEAT-930");
    fillMarkdownTokens(packageDir);
    const target = join(packageDir, "01-requirements.md");
    unlinkSync(target);
    linkSync(join(packageDir, "00-feature-brief.md"), target);
    assertRejected(run(checker, ["--json", packageDir]), /hardlink|nlink|alias|dev\+ino/i);
  });

  await t.test("materialized Summary with an external hardlink", () => {
    const state = prepareThroughG4(t, { id: "FEAT-931" });
    const created = run(process.execPath, [materializer, state.packageDir]);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    linkSync(join(state.packageDir, "10-delivery-summary.md"), join(dirname(state.packageDir), "summary-hardlink.md"));
    assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /hardlink|nlink|独占文件|dev\+ino/i);
  });
});

test("Summary materialization honors the package-wide exclusive lock", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-932" });
  const lockPath = join(state.packageDir, ".cfd-materialize.lock");
  const lockContent = '{"pid":999999,"acquired_at":"2026-08-11T00:00:00Z","token":"other"}\n';
  writeFileSync(lockPath, lockContent);
  const result = run(process.execPath, [materializer, state.packageDir]);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /lock|另一个 materializer|正在操作/i);
  assert.equal(readFileSync(lockPath, "utf8"), lockContent, "contending process must not remove another owner lock");
  assert.equal(existsSync(join(state.packageDir, "10-delivery-summary.md")), false);
});

test("Delivery Summary symlinks cannot escape the package", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-919" });
  const materialized = run(process.execPath, [materializer, state.packageDir]);
  assert.equal(materialized.status, 0, `${materialized.stdout}\n${materialized.stderr}`);
  const summaryPath = join(state.packageDir, "10-delivery-summary.md");
  const outsidePath = join(dirname(state.packageDir), "outside-summary.md");
  writeFileSync(outsidePath, readFileSync(summaryPath, "utf8"));
  unlinkSync(summaryPath);
  symlinkSync(outsidePath, summaryPath);
  assertRejected(run(checker, ["--strict", "--json", state.packageDir]), /symlink|symbolic|软链|符号链接|路径|越出/i);
});

test("generator safely round-trips titles containing backslashes", (t) => {
  const title = String.raw`Windows C:\queue\q is literal`;
  const packageDir = createPackage(t, "FEAT-920", "lite", "local_engineering", { title, slug: "backslash-title" });
  const manifest = readYaml(join(packageDir, "feature.yaml"));
  assert.equal(manifest.feature.title, title);
  assert.equal(manifest.feature.summary, title);
});

test("pending and NOT RUN cannot become a green Gate", (t) => {
  const packageDir = createPackage(t, "FEAT-921");
  fillMarkdownTokens(packageDir);
  const g4 = run(checker, ["--gate", "G4", "--json", packageDir]);
  assert.equal(g4.status, 1);
  const report = jsonReport(g4);
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.gates[0].state, "pending");
  assert.equal(report.gates[0].eligibility, "BLOCKED");

  const g6 = run(checker, ["--gate", "G6", "--json", packageDir]);
  assert.equal(g6.status, 0);
  assert.equal(jsonReport(g6).gates[0].state, "not_applicable");
});

test("not_run Evidence records require an explicit reason and follow-up", (t) => {
  const packageDir = createPackage(t, "FEAT-NOT-RUN-NOTES");
  const ledgerPath = join(packageDir, "evidence.yaml");
  const record = evidence({ id: "EV-NOT-RUN-001", kind: "unit_test", artifacts: false });
  record.execution.result = "not_run";
  record.execution.exit_code = 1;
  record.notes = "";
  writeYaml(ledgerPath, { schema_version: 2, kind: "EvidenceLedger", feature_id: "FEAT-NOT-RUN-NOTES", entries: [record] });
  assertRejected(run(checker, ["--json", packageDir]), /not_run.*notes|原因.*补验证/i);
});

test("unregistered legacy v1 is rejected and never called PASS", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-feature-delivery-v1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "feature.yaml"), "schema_version: 1\n");
  assert.equal(run(checker, ["--repository-root", project.root, "--project-config", project.configPath, root]).status, 1);
  const allowed = run(checker, ["--repository-root", project.root, "--project-config", project.configPath, "--allow-legacy", "--json", root]);
  assert.notEqual(allowed.status, 0);
  const report = jsonReport(allowed);
  assert.equal(report.valid, false);
  assert.equal(report.recognized, false);
  assert.equal(report.verdict, "LEGACY_REJECTED");
});

test("a production package can reach G6 with continuous target-bound evidence", (t) => {
  const state = prepareThroughG4(t, { id: "FEAT-923", profile: "standard", target: "production" });
  const g4Decision = state.decisionLedger.entries.find((entry) => entry.gate === "G4");
  const g4CodeRefs = structuredClone(g4Decision.subject.code_refs);
  const releaseRef = { id: "release", digest: sha256("artifact:EV-FEAT-923-REL") };
  const releaseArtifact = evidence({ id: "EV-FEAT-923-REL", kind: "release_artifact", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], codeSha: PRIMARY_SHA, baseSha: PRIMARY_SHA, recordedAt: iso(-18), startedAt: iso(-20), finishedAt: iso(-19) });
  const rollback = evidence({ id: "EV-FEAT-923-RBK", kind: "rollback_rehearsal", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], recordedAt: iso(-18), startedAt: iso(-20), finishedAt: iso(-19) });
  state.evidenceLedger.entries.push(releaseArtifact, rollback);
  writeYaml(state.evidencePath, state.evidenceLedger);
  let inspection = jsonReport(run(checker, ["--json", state.packageDir]));
  const releaseAuthorization = buildAuthorization(state.manifest, ["production-release"], "production");
  releaseAuthorization.allowed_actions = ["deployment"];
  releaseAuthorization.excluded_actions = releaseAuthorization.excluded_actions.filter((item) => item !== "deployment");
  releaseAuthorization.required_evidence = ["release_execution", "smoke", "observation", "owner_acceptance_or_outcome_metric"];
  let sequence = state.decisionLedger.entries.length + 1;
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-923-G5",
    sequence: sequence++,
    gate: "G5",
    roles: ["release_owner"],
    digests: inspection.digests,
    evidenceRefs: [evidenceRef(inspection, releaseArtifact.id), evidenceRef(inspection, rollback.id)],
    subjectOverrides: {
      code_refs: g4CodeRefs,
      artifact_refs: [releaseRef],
      engineering_decision_ref: { id: g4Decision.id, digest: inspection.digests.decisions[g4Decision.id] },
      environment_ref: "production",
      account_ref: "test-account",
      rollback_ref: rollback.id,
    },
    authorization: releaseAuthorization,
    decidedAt: iso(-15),
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  const g5 = run(checker, ["--gate", "G5", "--json", state.packageDir]);
  assert.equal(g5.status, 0, `${g5.stdout}\n${g5.stderr}`);

  const acceptanceCriteria = state.manifest.acceptance_criteria.map((criterion) => criterion.id);
  const releaseExecution = evidence({ id: "EV-FEAT-923-EXEC", kind: "release_execution", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], acceptanceCriteria, codeSha: PRIMARY_SHA, baseSha: PRIMARY_SHA, recordedAt: iso(-6), startedAt: iso(-8), finishedAt: iso(-7) });
  releaseExecution.artifacts = [releaseArtifact.artifacts[0]];
  const smoke = evidence({ id: "EV-FEAT-923-SMOKE", kind: "smoke", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], acceptanceCriteria, recordedAt: iso(-5), startedAt: iso(-7), finishedAt: iso(-6) });
  const observation = evidence({ id: "EV-FEAT-923-OBS", kind: "observation", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], acceptanceCriteria, recordedAt: iso(-4), startedAt: iso(-6), finishedAt: iso(-5) });
  const acceptance = evidence({ id: "EV-FEAT-923-ACCEPT", kind: "owner_acceptance", environment: "production", accountRef: "test-account", artifactRefs: [releaseRef], acceptanceCriteria, recordedAt: iso(-3), startedAt: iso(-5), finishedAt: iso(-4) });
  state.evidenceLedger.entries.push(releaseExecution, smoke, observation, acceptance);
  writeYaml(state.evidencePath, state.evidenceLedger);
  inspection = jsonReport(run(checker, ["--json", state.packageDir]));
  state.decisionLedger.entries.push(decision({
    id: "DEC-FEAT-923-G6",
    sequence,
    gate: "G6",
    roles: ["requirement_owner"],
    digests: inspection.digests,
    evidenceRefs: [releaseExecution, smoke, observation, acceptance].map((entry) => evidenceRef(inspection, entry.id)),
    subjectOverrides: {
      code_refs: g4CodeRefs,
      artifact_refs: [releaseRef],
      engineering_decision_ref: { id: g4Decision.id, digest: inspection.digests.decisions[g4Decision.id] },
      environment_ref: "production",
      account_ref: "test-account",
    },
    decidedAt: iso(-1),
  }));
  writeYaml(state.decisionsPath, state.decisionLedger);
  const g6 = run(checker, ["--gate", "G6", "--json", state.packageDir]);
  assert.equal(g6.status, 0, `${g6.stdout}\n${g6.stderr}`);
  assert.equal(jsonReport(g6).gates[0].state, "passed");

  const materialized = run(process.execPath, [materializer, state.packageDir]);
  assert.equal(materialized.status, 0, `${materialized.stdout}\n${materialized.stderr}`);
  fillMarkdownTokens(state.packageDir);
  const strict = run(checker, ["--strict", "--json", state.packageDir]);
  assert.equal(strict.status, 0, `${strict.stdout}\n${strict.stderr}`);

  const canonicalEvidenceLedger = structuredClone(state.evidenceLedger);
  const canonicalDecisionLedger = structuredClone(state.decisionLedger);
  const runMutatedGate = (gate, mutate) => {
    const evidenceLedger = structuredClone(canonicalEvidenceLedger);
    const decisionLedger = structuredClone(canonicalDecisionLedger);
    mutate(evidenceLedger, decisionLedger);
    writeYaml(state.evidencePath, evidenceLedger);
    writeYaml(state.decisionsPath, decisionLedger);
    const changedReport = jsonReport(run(checker, ["--json", state.packageDir]));
    const decisionEntry = decisionLedger.entries.find((entry) => entry.gate === gate);
    for (const reference of decisionEntry.evidence_refs) {
      if (changedReport.digests.evidence[reference.id]) reference.digest = changedReport.digests.evidence[reference.id];
    }
    writeYaml(state.decisionsPath, decisionLedger);
    return run(checker, ["--gate", gate, "--json", state.packageDir]);
  };

  const beforeG5 = runMutatedGate("G6", (evidenceLedger, decisionLedger) => {
    const g5Decision = decisionLedger.entries.find((entry) => entry.gate === "G5");
    const smokeEvidence = evidenceLedger.entries.find((entry) => entry.kind === "smoke");
    smokeEvidence.execution.started_at = new Date(Date.parse(g5Decision.decided_at) - 120_000).toISOString();
    smokeEvidence.execution.finished_at = new Date(Date.parse(g5Decision.decided_at) - 60_000).toISOString();
  });
  assertRejected(beforeG5, /晚于当前 G5|post.?G5|执行时间/i);

  const outOfOrder = runMutatedGate("G6", (evidenceLedger) => {
    const smokeEvidence = evidenceLedger.entries.find((entry) => entry.kind === "smoke");
    smokeEvidence.execution.started_at = iso(-8);
    smokeEvidence.execution.finished_at = iso(-6);
  });
  assertRejected(outOfOrder, /时间顺序|finished_at|started_at|不晚于/i);

  const missingCoverage = runMutatedGate("G6", (evidenceLedger) => {
    evidenceLedger.entries.find((entry) => entry.kind === "smoke").subject.acceptance_criteria = [];
  });
  assertRejected(missingCoverage, /acceptance criterion|AC-001|未覆盖/i);

  const wrongAccount = runMutatedGate("G6", (evidenceLedger) => {
    evidenceLedger.entries.find((entry) => entry.kind === "observation").subject.account_ref = "other-account";
  });
  assertRejected(wrongAccount, /account_ref|account|账号/i);

  const wrongArtifact = runMutatedGate("G6", (evidenceLedger) => {
    evidenceLedger.entries.find((entry) => entry.kind === "owner_acceptance").subject.artifact_refs = [{ id: "release", digest: sha256("wrong-release") }];
  });
  assertRejected(wrongArtifact, /artifact_refs|release artifact|制品/i);

  const g5AccountMismatch = runMutatedGate("G5", (evidenceLedger) => {
    evidenceLedger.entries.find((entry) => entry.kind === "release_artifact").subject.account_ref = "other-account";
  });
  assertRejected(g5AccountMismatch, /authorization\.account|account_ref|account|账号/i);

  const g5CodeProvenanceMismatch = runMutatedGate("G5", (evidenceLedger) => {
    evidenceLedger.entries.find((entry) => entry.kind === "release_artifact").subject.code_sha = DRIFT_SHA;
  });
  assertRejected(g5CodeProvenanceMismatch, /release_artifact provenance|code_ref|逐仓绑定/i);
});
