import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { createProjectFixture, run } from "./project-fixture.mjs";

const distributionFrameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function report(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`evaluator did not return JSON (${error.message})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function generatedProject(t, id) {
  const fixture = createProjectFixture(distributionFrameworkDir);
  t.after(() => fixture.cleanup());
  const generated = run(fixture.scripts.newFeature, [
    id,
    "gate-policy-schema",
    "--profile", "lite",
    "--target", "local_engineering",
    "--title", "Gate policy schema regression",
    "--owner", "Test Owner",
    "--scope", "src/app",
  ], { cwd: fixture.root });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  return { fixture, packageDir: join(fixture.featureDir, `${id}-gate-policy-schema`) };
}

function mutateActivePolicy(fixture, mutatePolicy) {
  const policyPath = join(fixture.frameworkDir, "gate-policy.yaml");
  const policy = YAML.parse(readFileSync(policyPath, "utf8"), { uniqueKeys: true });
  mutatePolicy(policy);
  writeFileSync(policyPath, YAML.stringify(policy, { lineWidth: 0 }));
}

test("evaluator fails closed when human_actor_required is missing or misspelled", async (t) => {
  await t.test("missing field", (t) => {
    const { fixture, packageDir } = generatedProject(t, "FEAT-POLICY-SCHEMA-MISSING");
    mutateActivePolicy(fixture, (policy) => { delete policy.gates.G0.human_actor_required; });
    const result = run(process.execPath, [fixture.scripts.evaluator, "--json", packageDir]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(report(result).errors.join("\n"), /G0\.human_actor_required.*缺少必填字段/);
  });

  await t.test("misspelled field", (t) => {
    const { fixture, packageDir } = generatedProject(t, "FEAT-POLICY-SCHEMA-MISSPELLED");
    mutateActivePolicy(fixture, (policy) => {
      policy.gates.G0.human_actor_require = policy.gates.G0.human_actor_required;
      delete policy.gates.G0.human_actor_required;
    });
    const result = run(process.execPath, [fixture.scripts.evaluator, "--json", packageDir]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(report(result).errors.join("\n"), /G0\.human_actor_require.*不允许的字段/);
  });
});
