import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { loadActiveGatePolicy, resolveGatePolicy } from "../scripts/policy-registry.mjs";
import { createProjectFixture } from "./project-fixture.mjs";

const frameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectByFramework = new Map();

function digest(source) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function copyFramework(t) {
  const fixture = createProjectFixture(frameworkDir);
  t.after(() => fixture.cleanup());
  projectByFramework.set(fixture.frameworkDir, fixture);
  return fixture.frameworkDir;
}

function switchActivePolicy(copiedFramework, version = "2.0.1") {
  const activePath = join(copiedFramework, "gate-policy.yaml");
  const policy = YAML.parse(readFileSync(activePath, "utf8"), { uniqueKeys: true });
  policy.policy.version = version;
  const source = YAML.stringify(policy, { lineWidth: 0 });
  const policyDigest = digest(source);
  writeFileSync(activePath, source);
  writeFileSync(join(copiedFramework, "policies", `${policyDigest.slice(7)}.yaml`), source);
  return { policy, source, digest: policyDigest };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", env: process.env, ...options });
}

function parseReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`expected JSON report (${error.message})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

test("active policy is schema-valid and byte-identical to its content-addressed snapshot", () => {
  const active = loadActiveGatePolicy(frameworkDir);
  assert.equal(active.digest, digest(active.source));
  assert.equal(readFileSync(active.archivedPath, "utf8"), active.source);
  assert.equal(resolveGatePolicy({
    id: active.data.policy.id,
    version: active.data.policy.version,
    digest: active.digest,
  }, frameworkDir).active, true);
});

test("registry rejects missing, tampered, and unarchived active snapshots", (t) => {
  const missingFramework = copyFramework(t);
  const missingActive = loadActiveGatePolicy(missingFramework);
  unlinkSync(missingActive.archivedPath);
  assert.throws(() => loadActiveGatePolicy(missingFramework), /snapshot 不存在|归档/i);

  const tamperedFramework = copyFramework(t);
  const tamperedActive = loadActiveGatePolicy(tamperedFramework);
  writeFileSync(tamperedActive.archivedPath, `${tamperedActive.source}\n# tampered\n`);
  assert.throws(() => loadActiveGatePolicy(tamperedFramework), /digest|bytes|完全相同/i);

  const unarchivedFramework = copyFramework(t);
  const activePath = join(unarchivedFramework, "gate-policy.yaml");
  writeFileSync(activePath, `${readFileSync(activePath, "utf8")}\n`);
  assert.throws(() => loadActiveGatePolicy(unarchivedFramework), /snapshot 不存在|归档/i);
});

test("historical policy resolution is content-addressed, schema-strict, and id/version-bound", (t) => {
  const copiedFramework = copyFramework(t);
  const historical = loadActiveGatePolicy(copiedFramework);
  switchActivePolicy(copiedFramework);
  const historicalRef = {
    id: historical.data.policy.id,
    version: historical.data.policy.version,
    digest: historical.digest,
  };
  const resolved = resolveGatePolicy(historicalRef, copiedFramework);
  assert.equal(resolved.active, false);
  assert.equal(resolved.digest, historical.digest);
  assert.equal(resolved.data.policy.version, historical.data.policy.version);

  assert.throws(
    () => resolveGatePolicy({ ...historicalRef, version: "9.9.9" }, copiedFramework),
    /id\/version.*不一致/i,
  );

  const malformedSource = historical.source.replace("    human_actor_required: true", "    human_actor_require: true");
  const malformedDigest = digest(malformedSource);
  writeFileSync(join(copiedFramework, "policies", `${malformedDigest.slice(7)}.yaml`), malformedSource);
  assert.throws(
    () => resolveGatePolicy({ ...historicalRef, digest: malformedDigest }, copiedFramework),
    /Schema:.*human_actor_(?:require|required)/i,
  );

  const historicalPath = join(copiedFramework, "policies", `${historical.digest.slice(7)}.yaml`);
  writeFileSync(historicalPath, historical.source.replace("human_actor_required:", "human_actor_require:"));
  assert.throws(() => resolveGatePolicy(historicalRef, copiedFramework), /digest|Schema/i);
});

test("a signed Decision and package remain verifiable after the active policy switches", (t) => {
  const copiedFramework = copyFramework(t);
  const fixture = projectByFramework.get(copiedFramework);
  const keyRoot = mkdtempSync(join(tmpdir(), "cfd-policy-keys-"));
  const trustRoot = join(keyRoot, "approval-trust.yaml");
  const privateKeyPath = join(keyRoot, "approval-private.pem");
  t.after(() => rmSync(keyRoot, { recursive: true, force: true }));
  const newFeature = fixture.scripts.newFeature;
  const evaluator = fixture.scripts.evaluator;
  const signer = fixture.scripts.signer;
  const generated = run(newFeature, [
    "FEAT-POLICY-HISTORY",
    "policy-history",
    "--profile", "lite",
    "--target", "local_engineering",
    "--title", "Historical policy verification",
    "--owner", "Test Owner",
    "--scope", "src/app",
  ], { cwd: fixture.root });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const packageDir = join(fixture.featureDir, "FEAT-POLICY-HISTORY-policy-history");
  const briefPath = join(packageDir, "00-feature-brief.md");
  writeFileSync(briefPath, readFileSync(briefPath, "utf8").replace(/\{\{[A-Z0-9_]+\}\}/g, "filled"));

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(trustRoot, YAML.stringify({
    schema_version: 1,
    kind: "FeatureDeliveryApprovalTrust",
    keys: [{
      id: "historical-policy-key",
      actor: "Test Owner",
      roles: ["requirement_owner"],
      gates: ["G0"],
      profiles: ["lite"],
      targets: ["local_engineering"],
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
      valid_from: "2020-01-01T00:00:00Z",
      valid_until: null,
    }],
  }, { lineWidth: 0 }));

  const inspection = run(process.execPath, [evaluator, "--json", "--trust-root", trustRoot, packageDir]);
  assert.equal(inspection.status, 0, `${inspection.stdout}\n${inspection.stderr}`);
  const digests = parseReport(inspection).digests;
  const ledgerPath = join(packageDir, "decisions.yaml");
  const ledger = YAML.parse(readFileSync(ledgerPath, "utf8"), { uniqueKeys: true });
  ledger.entries = [{
    id: "DEC-FEAT-POLICY-HISTORY-001",
    sequence: 1,
    gate: "G0",
    instance: "feature",
    state: "passed",
    actor: { id: "Test Owner", type: "human" },
    roles: ["requirement_owner"],
    decided_at: new Date(Date.now() - 60_000).toISOString(),
    valid_until: null,
    subject: {
      policy_digest: digests.policy_digest,
      declaration_digest: digests.declaration_digest,
      intake_digest: digests.intake_digest,
      scope_digest: null,
      build_digest: null,
      boundary_digest: null,
      slice_digest: null,
      engineering_digest: null,
      release_digest: null,
      spec_digest: null,
      code_refs: [],
      artifact_refs: [],
      engineering_decision_ref: null,
      environment_ref: null,
      account_ref: null,
      rollback_ref: null,
    },
    evidence_refs: [],
    authorization: {
      instances: [], repositories: [], paths: [], base_refs: [], environment: null, account: null,
      data_classification: null, budget: { currency: null, maximum: null }, allowed_actions: [],
      excluded_actions: [], stop_conditions: [], required_evidence: [], reauthorize_on: [],
    },
    attestation: null,
    rationale: "Historical G0 approval",
    supersedes: null,
  }];
  writeFileSync(ledgerPath, YAML.stringify(ledger, { lineWidth: 0 }));
  const signed = run(process.execPath, [
    signer, packageDir, ledger.entries[0].id,
    "--key-id", "historical-policy-key",
    "--private-key", privateKeyPath,
    "--trust-root", trustRoot,
  ]);
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);

  const before = run(process.execPath, [evaluator, "--gate", "G0", "--json", "--trust-root", trustRoot, packageDir]);
  assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`);

  switchActivePolicy(copiedFramework);
  const historicalSigner = join(copiedFramework, "scripts/sign-decision.mjs");
  const historicalLedger = YAML.parse(readFileSync(ledgerPath, "utf8"), { uniqueKeys: true });
  historicalLedger.entries.push({
    ...historicalLedger.entries[0],
    id: "DEC-FEAT-POLICY-HISTORY-002",
    sequence: 2,
    decided_at: new Date().toISOString(),
    attestation: null,
    rationale: "Superseding approval signed after active policy switch",
    supersedes: historicalLedger.entries[0].id,
  });
  writeFileSync(ledgerPath, YAML.stringify(historicalLedger, { lineWidth: 0 }));
  const historicalSigned = run(process.execPath, [
    historicalSigner, packageDir, historicalLedger.entries[1].id,
    "--key-id", "historical-policy-key",
    "--private-key", privateKeyPath,
    "--trust-root", trustRoot,
  ]);
  assert.equal(historicalSigned.status, 0, `${historicalSigned.stdout}\n${historicalSigned.stderr}`);
  const historicalEvaluator = join(copiedFramework, "scripts/evaluate-feature-package.mjs");
  const after = run(process.execPath, [historicalEvaluator, "--gate", "G0", "--json", "--trust-root", trustRoot, packageDir]);
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
  assert.equal(parseReport(after).digests.policy_digest, digests.policy_digest);
});
