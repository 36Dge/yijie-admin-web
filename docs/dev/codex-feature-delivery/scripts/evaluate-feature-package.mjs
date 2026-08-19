#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";
import { validateApprovalTrustRoot, verifyApprovalAttestation } from "./approval-attestation.mjs";
import { recognizeLegacyPackage } from "./legacy-v1.mjs";
import { resolveGatePolicy } from "./policy-registry.mjs";
import { loadProjectContext } from "./project-context.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = resolve(FRAMEWORK_DIR, "schemas/feature-package.schema.json");
const GLOBAL_GATES = ["G0", "G1", "G2", "G4", "G5", "G6"];
const ALL_GATES = ["G0", "G1", "G2", "G2C", "G3", "G4", "G5", "G6"];
const TEST_EVIDENCE = new Set(["unit_test", "integration_test", "contract_test", "e2e_test", "ai_eval"]);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MODULE_PATH = fileURLToPath(import.meta.url);

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(MODULE_PATH);
  } catch {
    return false;
  }
}
const SUMMARY_HEADER_FIELDS = [
  "schema_version",
  "kind",
  "feature_id",
  "delivery_target",
  "terminal_gate",
  "terminal_decision_id",
  "terminal_decision_digest",
  "terminal_subject_digest",
  "delivery_claim",
  "generated_at",
  "summary_body_digest",
];

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  check-feature-package.sh [options] PACKAGE_DIR

Options:
  --gate G0|G1|G2|G2C|G3|G4|G5|G6
  --instance feature|BND-NNN|SLC-NNN
  --strict          Require every gate through the delivery target terminal gate.
  --json            Emit a machine-readable report, including current digests.
  --trust-root FILE Verify passed Decisions against this external approval trust root.
  --project-config FILE
                    Project-root .feature-delivery.yaml; otherwise discovered from Git root.
  --repository-root DIRECTORY
                    Bind repositories[].identity.kind=current to this Git root.
  --allow-legacy    Recognize an exactly pinned schema v1 tree; valid stays false and exit stays nonzero.
  -h, --help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    gate: null,
    instance: null,
    strict: false,
    json: false,
    allowLegacy: false,
    trustRoot: process.env.CFD_APPROVAL_TRUST_ROOT ? resolve(process.env.CFD_APPROVAL_TRUST_ROOT) : null,
    projectConfig: null,
    repositoryRoot: null,
    packageDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--allow-legacy") options.allowLegacy = true;
    else if (arg === "--project-config") {
      const value = argv[++index];
      if (!value) throw new Error("--project-config 缺少值");
      options.projectConfig = resolve(value);
    } else if (arg.startsWith("--project-config=")) {
      const value = arg.slice("--project-config=".length);
      if (!value) throw new Error("--project-config 缺少值");
      options.projectConfig = resolve(value);
    }
    else if (arg === "--trust-root") {
      const value = argv[++index];
      if (!value) throw new Error("--trust-root 缺少值");
      options.trustRoot = resolve(value);
    } else if (arg.startsWith("--trust-root=")) {
      const value = arg.slice("--trust-root=".length);
      if (!value) throw new Error("--trust-root 缺少值");
      options.trustRoot = resolve(value);
    } else if (arg === "--repository-root") {
      const value = argv[++index];
      if (!value) throw new Error("--repository-root 缺少值");
      options.repositoryRoot = resolve(value);
    } else if (arg.startsWith("--repository-root=")) {
      const value = arg.slice("--repository-root=".length);
      if (!value) throw new Error("--repository-root 缺少值");
      options.repositoryRoot = resolve(value);
    }
    else if (arg === "--gate") options.gate = argv[++index] ?? null;
    else if (arg.startsWith("--gate=")) options.gate = arg.slice("--gate=".length);
    else if (arg === "--instance") options.instance = argv[++index] ?? null;
    else if (arg.startsWith("--instance=")) options.instance = arg.slice("--instance=".length);
    else if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    else if (options.packageDir) throw new Error("只能指定一个 PACKAGE_DIR。 ");
    else options.packageDir = arg;
  }
  if (!options.packageDir) throw new Error("缺少 PACKAGE_DIR。 ");
  if (options.gate && !ALL_GATES.includes(options.gate)) throw new Error(`未知 Gate：${options.gate}`);
  if ((options.gate === "G2C" || options.gate === "G3") && !options.instance) {
    throw new Error(`${options.gate} 必须同时指定 --instance。`);
  }
  if (options.instance && !options.gate) throw new Error("--instance 必须与 --gate 一起使用。 ");
  if (options.strict && options.gate) throw new Error("--strict 与 --gate 不能同时使用。 ");
  return options;
}

function gitRepositoryRoot(path) {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return realpathSync(result.stdout.trim());
}

function resolveCurrentRepositoryRoot(explicitRoot, packageDir) {
  if (explicitRoot) {
    if (!existsSync(explicitRoot)) throw new Error(`--repository-root 不存在：${explicitRoot}`);
    const metadata = lstatSync(explicitRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`--repository-root 必须是非符号链接目录：${explicitRoot}`);
    const canonical = realpathSync(explicitRoot);
    const discovered = gitRepositoryRoot(canonical);
    if (!discovered || discovered !== canonical) throw new Error(`--repository-root 必须精确指向 Git worktree 根：${explicitRoot}`);
    return canonical;
  }
  const discovered = gitRepositoryRoot(packageDir);
  if (!discovered) throw new Error(`Package 不属于可发现的 Git worktree；请显式提供 --repository-root 与 --project-config：${packageDir}`);
  return discovered;
}

function parseYaml(path) {
  const source = readFileSync(path, "utf8");
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  return { data: document.toJS(), source };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function replaceTokens(source, replacements) {
  let result = source;
  for (const [key, value] of Object.entries(replacements)) {
    if (value !== null && value !== undefined) result = result.replaceAll(`{{${key}}}`, () => String(value));
  }
  return result;
}

export function buildDeliverySummaryBody({
  manifest,
  terminalGate,
  terminalDecisionId,
  terminalDecisionDigest,
  terminalSubjectDigest,
  deliveryClaim,
  generatedAt,
}) {
  const templatePath = resolve(FRAMEWORK_DIR, "templates/feature-package/10-delivery-summary.md");
  const escapeCell = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  const applicableArtifacts = asArray(manifest.artifacts).filter((item) => item.applicability !== "not_applicable");
  const artifactNavigation = applicableArtifacts.map((item) => `\`${item.path}\``).join(", ") || "（无）";
  const traceRows = asArray(manifest.slices).map((slice) => {
    const boundaries = asArray(slice.boundary_ids).join(", ") || "none";
    const criteria = asArray(slice.acceptance_criteria).join(", ");
    return `| ${escapeCell(`${slice.id}; ${boundaries}`)} | ${escapeCell(slice.outcome)} | ${escapeCell(`${slice.id}; ${criteria}`)} | \`decisions.yaml\`; \`evidence.yaml\` |`;
  }).join("\n") || "| feature | Terminal subject accepted | n/a | `decisions.yaml`; `evidence.yaml` |";
  const body = replaceTokens(readFileSync(templatePath, "utf8"), {
    FEATURE_ID: manifest.feature?.id,
    FEATURE_SLUG: manifest.feature?.slug,
    TITLE: manifest.feature?.title,
    OWNER: manifest.feature?.owners?.accountable,
    OWNER_ID: manifest.feature?.owners?.accountable,
    PROFILE: manifest.feature?.profile,
    DELIVERY_TARGET: manifest.feature?.delivery_target,
    DATE: generatedAt.slice(0, 10),
    TERMINAL_GATE: terminalGate,
    TERMINAL_DECISION_ID: terminalDecisionId,
    TERMINAL_EVALUATOR_COMMAND: `check-feature-package.sh --gate ${terminalGate} .`,
    TERMINAL_SUBJECT_DIGEST: terminalSubjectDigest,
    TERMINAL_REFS: `${terminalDecisionId}; ${terminalDecisionDigest}; ${terminalSubjectDigest}`,
    DELIVERED_OUTCOME: `${manifest.feature?.summary}; ${deliveryClaim}`,
    OPERATING_ENTRYPOINTS: artifactNavigation,
    DELIVERY_TRACE_ROWS: traceRows,
    METRIC_REFS_AND_CONCLUSIONS: "从 `evidence.yaml` 的 `observation` / `outcome_metric` entries 复算；本摘要不复制指标值",
    CONTROL_REFS_AND_TRIGGERS: `profile=${manifest.feature?.profile}; risk=${manifest.classification?.risk}; data=${manifest.classification?.data}; 以 \`decisions.yaml\` 的有效期和 reauthorize_on 为准`,
    RISKS_AND_LEARNINGS: applicableArtifacts.some((item) => item.kind === "decisions_and_risks") ? "见 `03-decisions-and-risks.md` 与 `decisions.yaml`" : "见 `decisions.yaml`",
    FOLLOW_UPS: "不从完成状态推断后续；任何新增范围必须建立独立 Feature/Decision",
    HANDOFF_REFS: artifactNavigation,
  });
  const unresolvedToken = body.match(/\{\{[A-Z0-9_]+\}\}/)?.[0];
  if (unresolvedToken) throw new Error(`Delivery Summary 模板存在脚本未派生的变量：${unresolvedToken}`);
  return body;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function recordDigest(record) {
  return sha256(JSON.stringify(stableValue(record)));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addUniqueError(errors, message) {
  if (!errors.includes(message)) errors.push(message);
}

function requireObject(errors, value, label) {
  if (!isObject(value)) {
    addUniqueError(errors, `${label} 必须是 object。`);
    return {};
  }
  return value;
}

function requireString(errors, value, label) {
  if (typeof value !== "string" || value.trim() === "") addUniqueError(errors, `${label} 必须是非空字符串。`);
  return typeof value === "string" ? value : "";
}

function requireEnum(errors, value, allowed, label) {
  if (!allowed.includes(value)) addUniqueError(errors, `${label}=${JSON.stringify(value)} 不在允许值 ${allowed.join(" | ")} 中。`);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validRepositoryScopePath(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim() || value.includes("\\") || value.includes("\0")) return false;
  if (value === ".") return true;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || /[*?\[\]{}]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function scopeContains(parent, child) {
  if (!validRepositoryScopePath(parent) || !validRepositoryScopePath(child)) return false;
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function validPackageRelativePath(value) {
  return validRepositoryScopePath(value) && value !== ".";
}

function safeExistingFile(root, candidate, label, errors) {
  if (!pathInside(root, candidate) || !existsSync(candidate)) return null;
  try {
    const rootReal = realpathSync(root);
    const candidateStat = lstatSync(candidate);
    if (candidateStat.isSymbolicLink()) {
      addUniqueError(errors, `${label} 不得是符号链接。`);
      return null;
    }
    const candidateReal = realpathSync(candidate);
    if (!pathInside(rootReal, candidateReal)) {
      addUniqueError(errors, `${label} 的真实路径越出 Feature Package。`);
      return null;
    }
    if (!candidateStat.isFile()) {
      addUniqueError(errors, `${label} 必须是普通文件。`);
      return null;
    }
    return candidateReal;
  } catch (error) {
    addUniqueError(errors, `无法验证 ${label}：${error.message}`);
    return null;
  }
}

function validateManagedFileIdentities(manifest, packageDir, errors) {
  const managedFiles = [
    ["feature.yaml", "feature.yaml"],
    ["evidence.yaml", "evidence.yaml"],
    ["decisions.yaml", "decisions.yaml"],
    ...asArray(manifest.artifacts).map((artifact) => [artifact?.path, `artifact ${artifact?.id ?? artifact?.path}`]),
  ];
  const identities = new Map();
  const checkedPaths = new Set();
  for (const [relativePath, label] of managedFiles) {
    if (typeof relativePath !== "string" || relativePath.length === 0) continue;
    const candidate = resolve(packageDir, relativePath);
    if (!pathInside(packageDir, candidate) || !existsSync(candidate) || checkedPaths.has(candidate)) continue;
    checkedPaths.add(candidate);
    const safePath = safeExistingFile(packageDir, candidate, label, errors);
    if (!safePath) continue;
    try {
      const metadata = statSync(safePath);
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (metadata.nlink !== 1) addUniqueError(errors, `${label} 必须是独占文件，检测到 hardlink nlink=${metadata.nlink}。`);
      const previous = identities.get(identity);
      if (previous && previous.path !== candidate) {
        addUniqueError(errors, `${label} 与 ${previous.label} 指向同一 dev+ino，禁止 hardlink alias。`);
      } else {
        identities.set(identity, { path: candidate, label });
      }
    } catch (error) {
      addUniqueError(errors, `无法验证 ${label} 的文件身份：${error.message}`);
    }
  }
}

function isoTime(value) {
  return typeof value === "string" && ISO_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolveSchemaReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`仅支持本地 JSON Schema $ref：${reference}`);
  return reference.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

function validateJsonSchema(value, schema, rootSchema, path = "$", errors = []) {
  if (!schema) {
    errors.push(`${path}: Schema 节点不存在`);
    return errors;
  }
  if (schema.$ref) return validateJsonSchema(value, resolveSchemaReference(rootSchema, schema.$ref), rootSchema, path, errors);
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => validateJsonSchema(value, branch, rootSchema, path, []));
    if (!branches.some((branch) => branch.length === 0)) errors.push(`${path}: 不满足 anyOf`);
    return errors;
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => validateJsonSchema(value, branch, rootSchema, path, []));
    if (branches.filter((branch) => branch.length === 0).length !== 1) errors.push(`${path}: 必须且只能满足一个 oneOf 分支`);
    return errors;
  }
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: 必须等于 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: 不在枚举中`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      errors.push(`${path}: 类型必须为 ${types.join(" | ")}`);
      return errors;
    }
  }
  if (value === null) return errors;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: 长度小于 ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 不符合 pattern ${schema.pattern}`);
    if (schema.format === "date-time" && !isoTime(value)) errors.push(`${path}: 不是有效 date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: 小于 minimum ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: 必须大于 ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: 少于 ${schema.minItems} 项`);
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(stableValue(item)));
      if (new Set(serialized).size !== serialized.length) errors.push(`${path}: 数组项必须唯一`);
    }
    if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items, rootSchema, `${path}[${index}]`, errors));
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) errors.push(`${path}.${required}: 缺少必填字段`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateJsonSchema(child, schema.properties[key], rootSchema, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: 不允许的字段`);
      else if (isObject(schema.additionalProperties)) validateJsonSchema(child, schema.additionalProperties, rootSchema, `${path}.${key}`, errors);
    }
  }
  return errors;
}

function enforceSchema(value, definition, rootSchema, label, errors) {
  for (const error of validateJsonSchema(value, definition, rootSchema, label, [])) addUniqueError(errors, `Schema: ${error}`);
}

function intakeProjection(manifest) {
  return {
    policy: manifest.policy,
    feature: {
      id: manifest.feature?.id,
      slug: manifest.feature?.slug,
      title: manifest.feature?.title,
      summary: manifest.feature?.summary,
      profile: manifest.feature?.profile,
      delivery_target: manifest.feature?.delivery_target,
      owners: manifest.feature?.owners,
    },
    classification: manifest.classification,
    size: manifest.size,
  };
}

function scopeProjection(manifest) {
  return {
    intake: intakeProjection(manifest),
    acceptance_criteria: manifest.acceptance_criteria,
    repositories: asArray(manifest.repositories).map(({ id, identity, path, root_scope_justification, root_scope_exception_evidence_id, role }) => ({ id, identity, path, root_scope_justification, root_scope_exception_evidence_id, role })),
    dependencies: asArray(manifest.dependencies).map(({ id, type, owner }) => ({ id, type, owner })),
    boundaries: manifest.boundaries,
    slices: asArray(manifest.slices).map(({ authorization_decision_id: _authorization, ...slice }) => slice),
    artifacts: manifest.artifacts,
  };
}

function computeArtifactDigests(packageDir, artifacts, errors) {
  const byId = {};
  const byKind = {};
  for (const artifact of artifacts) {
    if (artifact?.applicability === "not_applicable" || typeof artifact?.path !== "string") continue;
    const candidate = resolve(packageDir, artifact.path);
    const safePath = safeExistingFile(packageDir, candidate, `artifact ${artifact.id ?? artifact.path}`, errors);
    if (!safePath) continue;
    try {
      const digest = sha256(readFileSync(safePath));
      byId[artifact.id] = digest;
      if (!byKind[artifact.kind]) byKind[artifact.kind] = {};
      byKind[artifact.kind][artifact.id] = digest;
    } catch (error) {
      addUniqueError(errors, `无法读取 artifact ${artifact.path}: ${error.message}`);
    }
  }
  return { byId, byKind };
}

function digestKinds(artifactDigests, kinds) {
  return Object.fromEntries(kinds.map((kind) => [kind, artifactDigests.byKind[kind] ?? {}]));
}

function computeDigests(manifest, manifestSource, artifactDigests, evidenceMap, decisions, policyDigest) {
  const intake = intakeProjection(manifest);
  const scope = scopeProjection(manifest);
  const intakeDigest = recordDigest({ declaration: intake, artifacts: digestKinds(artifactDigests, ["brief"]) });
  const scopeDigest = recordDigest({ declaration: scope, artifacts: digestKinds(artifactDigests, ["brief", "requirements", "impact_assessment"]) });
  const buildDigest = recordDigest({
    scope_digest: scopeDigest,
    repositories: asArray(manifest.repositories).map((repository) => ({ id: repository.id, baseline: repository.baseline })),
    dependencies: manifest.dependencies,
    artifacts: digestKinds(artifactDigests, ["decisions_and_risks", "technical_design", "test_plan", "implementation_plan"]),
  });
  const boundaryDigests = Object.fromEntries(asArray(manifest.boundaries).map((boundary) => [boundary.id, recordDigest({
    boundary,
    artifact_digest: artifactDigests.byId[boundary.artifact_id] ?? null,
  })]));
  const sliceById = new Map(asArray(manifest.slices).map((slice) => [slice.id, slice]));
  const sliceDigests = {};
  const sliceVisiting = new Set();
  const computeSliceDigest = (id) => {
    if (sliceDigests[id]) return sliceDigests[id];
    if (sliceVisiting.has(id)) return recordDigest({ invalid_cycle: id });
    sliceVisiting.add(id);
    const slice = sliceById.get(id) ?? {};
    const digest = recordDigest({
      slice: Object.fromEntries(Object.entries(slice).filter(([key]) => key !== "authorization_decision_id")),
      repository_baselines: asArray(manifest.repositories).filter((repository) => asArray(slice.repositories).includes(repository.id)).map((repository) => ({ id: repository.id, baseline: repository.baseline })),
      boundary_digests: asArray(slice.boundary_ids).map((boundaryId) => [boundaryId, boundaryDigests[boundaryId] ?? null]),
      predecessor_digests: asArray(slice.depends_on).map((predecessorId) => [predecessorId, computeSliceDigest(predecessorId)]),
    });
    sliceVisiting.delete(id);
    sliceDigests[id] = digest;
    return digest;
  };
  for (const slice of asArray(manifest.slices)) computeSliceDigest(slice.id);
  const engineeringDigest = recordDigest({
    build_digest: buildDigest,
    boundary_digests: boundaryDigests,
    slice_digests: sliceDigests,
    artifacts: digestKinds(artifactDigests, ["verification_report"]),
  });
  const releaseDigest = recordDigest({ engineering_digest: engineeringDigest, artifacts: digestKinds(artifactDigests, ["release_and_rollback"]) });
  const specDigest = recordDigest({ declaration: scope, normative_artifacts: Object.fromEntries(asArray(manifest.artifacts)
    .filter((artifact) => artifact.authority === "normative" && artifact.applicability !== "not_applicable")
    .map((artifact) => [artifact.id, artifactDigests.byId[artifact.id] ?? null])) });
  return {
    policy_digest: policyDigest,
    manifest_digest: sha256(manifestSource),
    declaration_digest: recordDigest(scope),
    intake_digest: intakeDigest,
    scope_digest: scopeDigest,
    build_digest: buildDigest,
    boundary_digests: boundaryDigests,
    slice_digests: sliceDigests,
    engineering_digest: engineeringDigest,
    release_digest: releaseDigest,
    spec_digest: specDigest,
    artifacts: artifactDigests.byId,
    evidence: Object.fromEntries([...evidenceMap.entries()].map(([id, entry]) => [id, entry.digest])),
    decisions: Object.fromEntries([...decisions.byId.entries()].map(([id, entry]) => [id, recordDigest(entry)])),
  };
}

function validateManifest(manifest, packageDir, policy, policyDigest, repositoryRegistry, currentRepositoryRoot, currentProjectRepository, errors, warnings) {
  if (manifest.schema_version !== 2) return;
  if (manifest.kind !== "FeaturePackage") addUniqueError(errors, "feature.yaml kind 必须为 FeaturePackage。 ");
  const policyRef = requireObject(errors, manifest.policy, "feature.yaml policy");
  if (policyRef.id !== policy.policy?.id || policyRef.version !== policy.policy?.version) {
    addUniqueError(errors, `Feature Package 必须绑定 policy ${policy.policy?.id}@${policy.policy?.version}。`);
  }
  if (policyRef.digest !== policyDigest) addUniqueError(errors, `Feature Package policy.digest 必须精确绑定已解析的内容寻址策略：${policyDigest}。`);

  const feature = requireObject(errors, manifest.feature, "feature");
  const featureId = requireString(errors, feature.id, "feature.id");
  const slug = requireString(errors, feature.slug, "feature.slug");
  if (featureId && !/^FEAT-[A-Z0-9][A-Z0-9.-]*$/.test(featureId)) addUniqueError(errors, "feature.id 必须符合 FEAT-*。 ");
  if (slug && !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) addUniqueError(errors, "feature.slug 格式无效。 ");
  requireString(errors, feature.title, "feature.title");
  requireString(errors, feature.summary, "feature.summary");
  requireEnum(errors, feature.lifecycle, ["proposed", "active", "blocked", "completed", "cancelled"], "feature.lifecycle");
  requireEnum(errors, feature.profile, policy.enums?.profiles ?? [], "feature.profile");
  requireEnum(errors, feature.delivery_target, policy.enums?.delivery_targets ?? [], "feature.delivery_target");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(feature.created_at ?? ""))) addUniqueError(errors, "feature.created_at 必须是 YYYY-MM-DD。 ");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(feature.updated_at ?? ""))) addUniqueError(errors, "feature.updated_at 必须是 YYYY-MM-DD。 ");
  const owners = requireObject(errors, feature.owners, "feature.owners");
  requireString(errors, owners.accountable, "feature.owners.accountable");
  if (!Array.isArray(owners.role_assignments) || owners.role_assignments.length === 0) {
    addUniqueError(errors, "feature.owners.role_assignments 至少需要一项。 ");
  } else {
    for (const [index, assignment] of owners.role_assignments.entries()) {
      requireString(errors, assignment?.actor, `role_assignments[${index}].actor`);
      if (!Array.isArray(assignment?.roles) || assignment.roles.length === 0) {
        addUniqueError(errors, `role_assignments[${index}].roles 至少需要一项。`);
      }
    }
  }

  const expectedPrefix = `${featureId}-${slug}`;
  if (featureId && slug && !packageDir.split(sep).at(-1)?.startsWith(expectedPrefix)) {
    addUniqueError(errors, `目录名必须以 ${expectedPrefix} 开头。`);
  }

  const classification = requireObject(errors, manifest.classification, "classification");
  requireEnum(errors, classification.risk, policy.enums?.risk_levels ?? [], "classification.risk");
  requireEnum(errors, classification.data, policy.enums?.data_classifications ?? [], "classification.data");
  if (!Array.isArray(classification.risk_factors)) addUniqueError(errors, "classification.risk_factors 必须是数组。 ");

  const profile = policy.profiles?.[feature.profile];
  if (profile) {
    if (!asArray(profile.allowed_risk).includes(classification.risk)) addUniqueError(errors, `${feature.profile} Profile 不允许 ${classification.risk} 风险。`);
    if (!asArray(profile.allowed_data).includes(classification.data)) addUniqueError(errors, `${feature.profile} Profile 不允许 ${classification.data} 数据。`);
    const factors = new Set(asArray(classification.risk_factors));
    const controlledFactors = asArray(policy.profile_escalation?.controlled_risk_factors).filter((item) => factors.has(item));
    const standardFactors = asArray(policy.profile_escalation?.minimum_standard_risk_factors).filter((item) => factors.has(item));
    if (controlledFactors.length > 0 && feature.profile !== "controlled") addUniqueError(errors, `风险因子 ${controlledFactors.join(", ")} 强制使用 controlled Profile。`);
    if (standardFactors.length > 0 && feature.profile === "lite") addUniqueError(errors, `风险因子 ${standardFactors.join(", ")} 至少需要 standard Profile。`);
  }

  const criteria = asArray(manifest.acceptance_criteria);
  const repositories = asArray(manifest.repositories);
  const dependencies = asArray(manifest.dependencies);
  const boundaries = asArray(manifest.boundaries);
  const slices = asArray(manifest.slices);
  const artifacts = asArray(manifest.artifacts);
  if (!Array.isArray(manifest.acceptance_criteria) || criteria.length === 0) addUniqueError(errors, "acceptance_criteria 至少需要一项。 ");
  if (!Array.isArray(manifest.repositories) || repositories.length === 0) addUniqueError(errors, "repositories 至少需要一项。 ");
  if (!Array.isArray(manifest.dependencies)) addUniqueError(errors, "dependencies 必须是数组。 ");
  if (!Array.isArray(manifest.boundaries)) addUniqueError(errors, "boundaries 必须是数组。 ");
  if (!Array.isArray(manifest.slices) || slices.length === 0) addUniqueError(errors, "slices 至少需要一项。 ");
  if (!Array.isArray(manifest.artifacts) || artifacts.length === 0) addUniqueError(errors, "artifacts 至少需要一项。 ");

  const size = requireObject(errors, manifest.size, "size");
  requireEnum(errors, size.class, policy.enums?.size_classes ?? [], "size.class");
  const actualCounts = { repositories: repositories.length, boundaries: boundaries.length, acceptance_criteria: criteria.length, slices: slices.length };
  for (const [key, actual] of Object.entries(actualCounts)) {
    if (size[key] !== actual) addUniqueError(errors, `size.${key}=${size[key]}，但实际为 ${actual}。`);
  }
  if (typeof size.estimated_active_days !== "number" || size.estimated_active_days <= 0) addUniqueError(errors, "size.estimated_active_days 必须大于 0。 ");
  const sizeOrder = ["small", "medium", "large"];
  let minimumSize = "large";
  for (const candidate of ["small", "medium"]) {
    const limits = policy.size_classification?.[candidate];
    if (limits
      && repositories.length <= limits.maximum_repositories
      && boundaries.length <= limits.maximum_boundaries
      && criteria.length <= limits.maximum_acceptance_criteria
      && slices.length <= limits.maximum_slices
      && dependencies.length <= limits.maximum_dependencies
      && size.estimated_active_days <= limits.maximum_estimated_active_days) {
      minimumSize = candidate;
      break;
    }
  }
  if (sizeOrder.indexOf(size.class) < sizeOrder.indexOf(minimumSize)) addUniqueError(errors, `size.class 低报：按 policy 至少应为 ${minimumSize}。`);
  if (profile) {
    if (!asArray(profile.allowed_size).includes(size.class)) addUniqueError(errors, `${feature.profile} Profile 不允许 ${size.class} Feature。`);
    if (repositories.length > profile.maximum_repositories) addUniqueError(errors, `${feature.profile} Profile 最多 ${profile.maximum_repositories} 个仓库。`);
    if (slices.length > profile.maximum_slices) addUniqueError(errors, `${feature.profile} Profile 最多 ${profile.maximum_slices} 个 Slice；请拆为 Epic/多个 Feature。`);
    if (!profile.boundaries_allowed && boundaries.length > 0) addUniqueError(errors, `${feature.profile} Profile 不允许跨 Boundary；请升级 Profile。`);
  }

  const criterionIds = criteria.map((item) => item?.id);
  const repositoryIds = repositories.map((item) => item?.id);
  const repositoryIdentities = repositories.map((item) => JSON.stringify(stableValue(item?.identity)));
  const dependencyIds = dependencies.map((item) => item?.id);
  const boundaryIds = boundaries.map((item) => item?.id);
  const sliceIds = slices.map((item) => item?.id);
  const artifactIds = artifacts.map((item) => item?.id);
  for (const [label, values] of Object.entries({ acceptance_criteria: criterionIds, repositories: repositoryIds, dependencies: dependencyIds, boundaries: boundaryIds, slices: sliceIds, artifacts: artifactIds })) {
    for (const duplicate of duplicateValues(values)) addUniqueError(errors, `${label} ID 重复：${duplicate}`);
  }
  for (const duplicate of duplicateValues(repositoryIdentities)) addUniqueError(errors, `repository identity 不得共享：${duplicate}`);
  for (const duplicate of duplicateValues(boundaries.map((item) => item?.artifact_id))) addUniqueError(errors, `Boundary artifact_id 不得共享：${duplicate}`);
  for (const duplicate of duplicateValues(artifacts.map((item) => item?.kind))) {
    if (duplicate !== "boundary_spec") addUniqueError(errors, `artifact kind 重复：${duplicate}`);
  }
  for (const duplicate of duplicateValues(artifacts.map((item) => item?.path))) addUniqueError(errors, `artifact path 重复：${duplicate}`);

  for (const [index, criterion] of criteria.entries()) {
    if (!/^AC-[0-9]{3,}$/.test(String(criterion?.id ?? ""))) addUniqueError(errors, `acceptance_criteria[${index}].id 格式无效。`);
    requireString(errors, criterion?.statement, `acceptance_criteria[${index}].statement`);
  }
  let currentRepositoryCount = 0;
  for (const [index, repository] of repositories.entries()) {
    if (!/^[a-z][a-z0-9._-]*$/.test(String(repository?.id ?? ""))) addUniqueError(errors, `repositories[${index}].id 格式无效。`);
    const identity = requireObject(errors, repository?.identity, `repositories[${index}].identity`);
    requireEnum(errors, identity.kind, ["current", "managed", "external"], `repositories[${index}].identity.kind`);
    const identityName = requireString(errors, identity.name, `repositories[${index}].identity.name`);
    const identityUrl = requireString(errors, identity.url, `repositories[${index}].identity.url`);
    const identityRoot = requireString(errors, identity.root, `repositories[${index}].identity.root`);
    if (identityName && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identityName)) addUniqueError(errors, `repositories[${index}].identity.name 格式无效。`);
    if (identityUrl && (identityUrl !== identityUrl.trim() || /[\s\0]/.test(identityUrl))) addUniqueError(errors, `repositories[${index}].identity.url 必须是无空白 canonical URL/identifier。`);
    const registered = asArray(repositoryRegistry?.repositories).find((item) => item?.id === repository?.id);
    if (!registered || registered.kind !== identity.kind || registered.name !== identityName || registered.url !== identityUrl || registered.root !== identityRoot) {
      addUniqueError(errors, `repositories[${index}] identity 必须与 repository registry 中同 ID 的 kind/name/url/root 精确一致。`);
    }
    if (identity.kind === "current") {
      currentRepositoryCount += 1;
      if (identityRoot !== ".") addUniqueError(errors, `repositories[${index}] current identity.root 必须是 "."。`);
      if (repository?.id !== currentProjectRepository.id || identityName !== currentProjectRepository.name || identityUrl !== currentProjectRepository.url) {
        addUniqueError(errors, `repositories[${index}] current identity 必须匹配项目配置的 canonical current repository。`);
      }
    } else if (identity.kind === "managed") {
      if (!registered) addUniqueError(errors, `repositories[${index}] managed identity 未在 repository registry 注册。`);
    } else if (identity.kind === "external") {
      if (!/^\.\.\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identityRoot) || identityRoot.slice(3) !== identityName) {
        addUniqueError(errors, `repositories[${index}] external identity.root 只允许显式单层 sibling ../<name>，且必须匹配 identity.name。`);
      }
    }
    if (!validRepositoryScopePath(repository?.path)) addUniqueError(errors, `repositories[${index}].path 必须是 repo 内规范相对路径；只有显式 "." 可代表整个 repository scope。`);
    if (repository?.path === ".") {
      requireString(errors, repository?.root_scope_justification, `repositories[${index}].root_scope_justification`);
      if (repository?.root_scope_exception_evidence_id !== null && typeof repository?.root_scope_exception_evidence_id !== "string") addUniqueError(errors, `repositories[${index}].root_scope_exception_evidence_id 必须为 string 或 null。`);
    } else if (repository?.root_scope_justification !== null || repository?.root_scope_exception_evidence_id !== null) {
      addUniqueError(errors, `repositories[${index}] 只有 path="." 时才允许 root scope justification/exception。`);
    }
    requireString(errors, repository?.role, `repositories[${index}].role`);
    const baseline = requireObject(errors, repository?.baseline, `repositories[${index}].baseline`);
    if (baseline.sha !== null && !SHA_RE.test(String(baseline.sha))) addUniqueError(errors, `${repository?.id}.baseline.sha 必须是完整 40 或 64 位 commit。`);
    if (baseline.evidence_id !== null && typeof baseline.evidence_id !== "string") addUniqueError(errors, `${repository?.id}.baseline.evidence_id 必须为 string 或 null。`);
  }
  if (currentRepositoryCount !== 1) addUniqueError(errors, "Feature Package 必须恰好声明一个 kind=current repository。");
  for (const [index, dependency] of dependencies.entries()) {
    requireString(errors, dependency?.id, `dependencies[${index}].id`);
    requireEnum(errors, dependency?.type, ["feature", "repository", "service", "environment", "decision", "external"], `dependencies[${index}].type`);
    requireEnum(errors, dependency?.status, ["unresolved", "resolved", "waived"], `dependencies[${index}].status`);
    requireString(errors, dependency?.owner, `dependencies[${index}].owner`);
    if (dependency?.status !== "unresolved" && !dependency?.evidence_id) addUniqueError(errors, `dependency ${dependency?.id} 为 ${dependency?.status} 时必须引用 evidence_id。`);
  }
  for (const [index, boundary] of boundaries.entries()) {
    if (!/^BND-[0-9]{3,}$/.test(String(boundary?.id ?? ""))) addUniqueError(errors, `boundaries[${index}].id 格式无效。`);
    requireEnum(errors, boundary?.type, policy.enums?.boundary_types ?? [], `boundaries[${index}].type`);
    requireEnum(errors, boundary?.impact, policy.enums?.boundary_impacts ?? [], `boundaries[${index}].impact`);
    requireString(errors, boundary?.owner, `boundaries[${index}].owner`);
    requireString(errors, boundary?.authority, `boundaries[${index}].authority`);
    if (!Array.isArray(boundary?.producers) || boundary.producers.length === 0) addUniqueError(errors, `${boundary?.id}.producers 至少需要一项。`);
    if (!Array.isArray(boundary?.consumers)) addUniqueError(errors, `${boundary?.id}.consumers 必须是数组。`);
    if (!Array.isArray(boundary?.known_unknowns)) addUniqueError(errors, `${boundary?.id}.known_unknowns 必须是数组。`);
    if (!artifactIds.includes(boundary?.artifact_id)) addUniqueError(errors, `${boundary?.id}.artifact_id 未指向已声明 artifact。`);
    if (boundary?.impact === "breaking" && feature.profile !== "controlled") addUniqueError(errors, `${boundary.id} 是 breaking，必须使用 controlled Profile。`);
  }

  const coveredCriteria = new Set();
  const scopedRepositories = new Set();
  for (const [index, slice] of slices.entries()) {
    if (!/^SLC-[0-9]{3,}$/.test(String(slice?.id ?? ""))) addUniqueError(errors, `slices[${index}].id 格式无效。`);
    requireString(errors, slice?.title, `slices[${index}].title`);
    requireString(errors, slice?.outcome, `slices[${index}].outcome`);
    for (const dependency of asArray(slice?.depends_on)) if (!sliceIds.includes(dependency)) addUniqueError(errors, `${slice?.id} 引用了不存在的 Slice ${dependency}。`);
    for (const boundary of asArray(slice?.boundary_ids)) if (!boundaryIds.includes(boundary)) addUniqueError(errors, `${slice?.id} 引用了不存在的 Boundary ${boundary}。`);
    for (const criterion of asArray(slice?.acceptance_criteria)) {
      if (!criterionIds.includes(criterion)) addUniqueError(errors, `${slice?.id} 引用了不存在的 AC ${criterion}。`);
      coveredCriteria.add(criterion);
    }
    for (const repository of asArray(slice?.repositories)) if (!repositoryIds.includes(repository)) addUniqueError(errors, `${slice?.id} 引用了不存在的 repository ${repository}。`);
    const slicePaths = asArray(slice?.paths);
    if (!Array.isArray(slice?.paths) || slicePaths.length === 0) addUniqueError(errors, `${slice?.id}.paths 至少需要一项结构化 repository/path scope。`);
    const pathRepositories = slicePaths.map((item) => item?.repository);
    if (!sameRefs(asArray(slice?.repositories), pathRepositories) || duplicateValues(pathRepositories).length > 0) {
      addUniqueError(errors, `${slice?.id}.paths 必须逐仓精确覆盖 slice.repositories，且每仓只能声明一个 path。`);
    }
    for (const [pathIndex, scopedPath] of slicePaths.entries()) {
      const repository = repositories.find((item) => item.id === scopedPath?.repository);
      if (!repository) {
        addUniqueError(errors, `${slice?.id}.paths[${pathIndex}] 引用了不存在的 repository ${scopedPath?.repository}。`);
        continue;
      }
      scopedRepositories.add(repository.id);
      if (!validRepositoryScopePath(scopedPath?.path)) addUniqueError(errors, `${slice?.id}.paths[${pathIndex}].path 不是安全的 repo 内相对路径。`);
      else if (!scopeContains(repository.path, scopedPath.path)) addUniqueError(errors, `${slice?.id}.paths[${pathIndex}].path=${scopedPath.path} 越出 ${repository.id} 声明范围 ${repository.path}。`);
    }
    if (slice?.authorization_decision_id !== null && typeof slice?.authorization_decision_id !== "string") addUniqueError(errors, `${slice?.id}.authorization_decision_id 必须为 string 或 null。`);
  }
  for (const criterion of criterionIds) if (!coveredCriteria.has(criterion)) addUniqueError(errors, `${criterion} 未映射到任何 Slice。`);
  for (const repository of repositoryIds) if (!scopedRepositories.has(repository)) addUniqueError(errors, `repository ${repository} 未被任何 Slice path 使用；不得扩大 G2 授权范围。`);

  const visiting = new Set();
  const visited = new Set();
  const dependencyMap = new Map(slices.map((slice) => [slice.id, asArray(slice.depends_on)]));
  function visitSlice(id) {
    if (visiting.has(id)) {
      addUniqueError(errors, `Slice 依赖形成环：${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencyMap.get(id) ?? []) visitSlice(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of sliceIds) visitSlice(id);

  const artifactKinds = new Map();
  const coreArtifactContract = {
    brief: ["00-feature-brief.md", "normative"],
    requirements: ["01-requirements.md", "normative"],
    impact_assessment: ["02-impact-assessment.md", "normative"],
    decisions_and_risks: ["03-decisions-and-risks.md", "normative"],
    contract_change_plan: ["04-contract-change-plan.md", "index"],
    technical_design: ["05-technical-design.md", "normative"],
    test_plan: ["06-test-plan.md", "normative"],
    implementation_plan: ["07-implementation-plan.md", "normative"],
    verification_report: ["08-verification-report.md", "index"],
    release_and_rollback: ["09-release-and-rollback.md", "normative"],
    delivery_summary: ["10-delivery-summary.md", "summary"],
  };
  for (const [index, artifact] of artifacts.entries()) {
    requireString(errors, artifact?.id, `artifacts[${index}].id`);
    requireString(errors, artifact?.kind, `artifacts[${index}].kind`);
    requireString(errors, artifact?.path, `artifacts[${index}].path`);
    if (!validPackageRelativePath(artifact?.path)) addUniqueError(errors, `artifact ${artifact?.id} path 必须是无 "."/".."/空段的 Package 内相对路径。`);
    requireEnum(errors, artifact?.authority, ["normative", "index", "summary", "operational"], `artifacts[${index}].authority`);
    requireEnum(errors, artifact?.applicability, ["required", "conditional", "not_applicable"], `artifacts[${index}].applicability`);
    requireString(errors, artifact?.reason, `artifacts[${index}].reason`);
    if (artifact?.kind !== "boundary_spec") artifactKinds.set(artifact?.kind, artifact);
    const expected = coreArtifactContract[artifact?.kind];
    if (expected && (artifact?.path !== expected[0] || artifact?.authority !== expected[1])) {
      addUniqueError(errors, `core artifact ${artifact?.kind} 必须是 path=${expected[0]}, authority=${expected[1]}。`);
    }
    const fullPath = resolve(packageDir, String(artifact?.path ?? ""));
    if (!pathInside(packageDir, fullPath)) addUniqueError(errors, `artifact ${artifact?.id} 路径越出 Feature Package。`);
    if (artifact?.applicability === "required") {
      if (!existsSync(fullPath)) addUniqueError(errors, `缺少适用 artifact：${artifact?.path}`);
      else {
        const safePath = safeExistingFile(packageDir, fullPath, `artifact ${artifact?.id}`, errors);
        if (safePath && statSync(safePath).size === 0) addUniqueError(errors, `artifact 不是非空文件：${artifact?.path}`);
      }
    }
  }
  for (const kind of Object.keys(coreArtifactContract)) if (!artifactKinds.has(kind)) addUniqueError(errors, `缺少 core artifact 声明：${kind}`);
  const requiredKinds = new Set([...(profile?.required_artifacts ?? []), ...(policy.delivery_targets?.[feature.delivery_target]?.additional_artifacts ?? [])]);
  if (boundaries.length > 0) requiredKinds.add("contract_change_plan");
  for (const kind of requiredKinds) {
    const artifact = artifactKinds.get(kind);
    if (!artifact || artifact.applicability !== "required") addUniqueError(errors, `${feature.profile}/${feature.delivery_target} 要求 required artifact kind=${kind}。`);
  }
  for (const boundary of boundaries) {
    const artifact = artifacts.find((item) => item.id === boundary.artifact_id);
    if (!artifact || artifact.kind !== "boundary_spec" || artifact.authority !== "normative" || artifact.applicability !== "required") {
      addUniqueError(errors, `${boundary.id}.artifact_id 必须指向独立的 required/normative boundary_spec artifact。`);
    }
    if (artifact && artifact.path !== `boundaries/${boundary.id}.md`) addUniqueError(errors, `${boundary.id} 的 boundary_spec path 必须是 boundaries/${boundary.id}.md。`);
  }
  if (feature.profile === "lite" && artifacts.some((artifact) => artifact.applicability === "required" && ["decisions_and_risks", "contract_change_plan", "technical_design"].includes(artifact.kind))) {
    warnings.push("Lite Package 包含扩展设计材料；若确有边界或风险，应升级到 standard。 ");
  }
}

function validateEvidence(ledger, featureId, policy, errors) {
  if (ledger.schema_version !== 2 || ledger.kind !== "EvidenceLedger") addUniqueError(errors, "evidence.yaml 必须是 schema v2 EvidenceLedger。 ");
  if (ledger.feature_id !== featureId) addUniqueError(errors, "evidence.yaml feature_id 与 feature.yaml 不一致。 ");
  if (!Array.isArray(ledger.entries)) {
    addUniqueError(errors, "evidence.yaml entries 必须是数组。 ");
    return new Map();
  }
  const map = new Map();
  const now = Date.now();
  for (const [index, entry] of ledger.entries.entries()) {
    const label = `evidence.entries[${index}]`;
    const id = requireString(errors, entry?.id, `${label}.id`);
    if (id && map.has(id)) addUniqueError(errors, `Evidence ID 重复：${id}`);
    requireEnum(errors, entry?.kind, policy.enums?.evidence_kinds ?? [], `${label}.kind`);
    if (!isoTime(entry?.recorded_at)) addUniqueError(errors, `${label}.recorded_at 必须是 ISO 时间。`);
    else if (Date.parse(entry.recorded_at) > now + 5 * 60 * 1000) addUniqueError(errors, `${label}.recorded_at 位于未来。`);
    const producer = requireObject(errors, entry?.producer, `${label}.producer`);
    requireString(errors, producer.id, `${label}.producer.id`);
    requireEnum(errors, producer.type, ["human", "ci", "codex", "tool", "system"], `${label}.producer.type`);
    const subject = requireObject(errors, entry?.subject, `${label}.subject`);
    requireString(errors, subject.instance, `${label}.subject.instance`);
    if (!Array.isArray(subject.acceptance_criteria)) addUniqueError(errors, `${label}.subject.acceptance_criteria 必须是数组。`);
    if (subject.code_sha !== null && subject.code_sha !== undefined && !SHA_RE.test(String(subject.code_sha))) addUniqueError(errors, `${label}.subject.code_sha 必须是完整 40 或 64 位 SHA。`);
    if (subject.base_sha !== null && subject.base_sha !== undefined && !SHA_RE.test(String(subject.base_sha))) addUniqueError(errors, `${label}.subject.base_sha 必须是完整 40 或 64 位 SHA。`);
    const execution = requireObject(errors, entry?.execution, `${label}.execution`);
    requireString(errors, execution.command, `${label}.execution.command`);
    requireString(errors, execution.tool, `${label}.execution.tool`);
    requireString(errors, execution.tool_version, `${label}.execution.tool_version`);
    if (!isoTime(execution.started_at) || !isoTime(execution.finished_at)) addUniqueError(errors, `${label}.execution 需要有效 started_at/finished_at。`);
    if (isoTime(execution.started_at) && isoTime(execution.finished_at) && Date.parse(execution.started_at) > Date.parse(execution.finished_at)) addUniqueError(errors, `${label}.execution.started_at 晚于 finished_at。`);
    if (isoTime(execution.finished_at) && isoTime(entry?.recorded_at) && Date.parse(execution.finished_at) > Date.parse(entry.recorded_at)) addUniqueError(errors, `${label}.execution.finished_at 晚于 recorded_at。`);
    if (!Number.isInteger(execution.exit_code)) addUniqueError(errors, `${label}.execution.exit_code 必须是整数。`);
    requireEnum(errors, execution.result, policy.enums?.evidence_results ?? [], `${label}.execution.result`);
    if (execution.result === "passed" && execution.exit_code !== 0) addUniqueError(errors, `${id} result=passed 但 exit_code 非 0。`);
    if (execution.result === "not_run" && execution.exit_code === 0) addUniqueError(errors, `${id} result=not_run 不能使用 exit_code=0。`);
    if (execution.result === "not_run" && (typeof entry?.notes !== "string" || entry.notes.trim() === "")) addUniqueError(errors, `${id} result=not_run 必须在 notes 记录原因和补验证条件。`);
    if (!Array.isArray(entry?.artifacts)) addUniqueError(errors, `${label}.artifacts 必须是数组。`);
    for (const [artifactIndex, artifact] of asArray(entry?.artifacts).entries()) {
      requireString(errors, artifact?.uri, `${label}.artifacts[${artifactIndex}].uri`);
      if (!DIGEST_RE.test(String(artifact?.digest ?? ""))) addUniqueError(errors, `${label}.artifacts[${artifactIndex}].digest 必须是 sha256。`);
      if (!isoTime(artifact?.retention_until)) addUniqueError(errors, `${label}.artifacts[${artifactIndex}].retention_until 必须是 ISO 时间。`);
    }
    if (typeof entry?.notes !== "string") addUniqueError(errors, `${label}.notes 必须是字符串。`);
    if (id) map.set(id, { ...entry, digest: recordDigest(entry) });
  }
  return map;
}

function validateEvidenceBindings(manifest, evidenceMap, errors) {
  for (const repository of asArray(manifest.repositories)) {
    if (!repository.baseline?.evidence_id) continue;
    const record = evidenceMap.get(repository.baseline.evidence_id);
    if (!record || record.kind !== "baseline" || record.execution?.result !== "passed" || record.execution?.exit_code !== 0
      || record.subject?.instance !== "feature" || record.subject?.repository !== repository.id || record.subject?.code_sha !== repository.baseline.sha) {
      addUniqueError(errors, `${repository.id}.baseline 必须逐仓绑定同 SHA 的成功 baseline Evidence。`);
    }
  }
  for (const dependency of asArray(manifest.dependencies)) {
    if (dependency.status === "unresolved") continue;
    const record = evidenceMap.get(dependency.evidence_id);
    const expectedKind = dependency.status === "waived" ? "exception" : "dependency_probe";
    if (!record || record.kind !== expectedKind || record.execution?.result !== "passed" || record.execution?.exit_code !== 0 || record.subject?.instance !== dependency.id) {
      addUniqueError(errors, `dependency ${dependency.id}=${dependency.status} 必须绑定成功的 ${expectedKind} Evidence。`);
    }
  }
}

function validateDecisions(ledger, featureId, manifest, policy, evidenceMap, errors) {
  if (ledger.schema_version !== 2 || ledger.kind !== "GateDecisionLedger") addUniqueError(errors, "decisions.yaml 必须是 schema v2 GateDecisionLedger。 ");
  if (ledger.feature_id !== featureId) addUniqueError(errors, "decisions.yaml feature_id 与 feature.yaml 不一致。 ");
  if (!Array.isArray(ledger.entries)) {
    addUniqueError(errors, "decisions.yaml entries 必须是数组。 ");
    return { byId: new Map(), latest: new Map() };
  }
  const byId = new Map();
  const latest = new Map();
  let previousSequence = 0;
  let previousDecisionTime = 0;
  const now = Date.now();
  for (const [index, entry] of ledger.entries.entries()) {
    const label = `decisions.entries[${index}]`;
    const id = requireString(errors, entry?.id, `${label}.id`);
    if (id && byId.has(id)) addUniqueError(errors, `Decision ID 重复：${id}`);
    if (!Number.isInteger(entry?.sequence) || entry.sequence <= previousSequence) addUniqueError(errors, `${label}.sequence 必须严格递增。`);
    previousSequence = Number.isInteger(entry?.sequence) ? entry.sequence : previousSequence;
    requireEnum(errors, entry?.gate, Object.keys(policy.gates ?? {}), `${label}.gate`);
    requireString(errors, entry?.instance, `${label}.instance`);
    requireEnum(errors, entry?.state, policy.enums?.decision_states ?? [], `${label}.state`);
    const actor = requireObject(errors, entry?.actor, `${label}.actor`);
    requireString(errors, actor.id, `${label}.actor.id`);
    requireEnum(errors, actor.type, ["human", "ci", "codex", "tool", "system"], `${label}.actor.type`);
    if (!Array.isArray(entry?.roles)) addUniqueError(errors, `${label}.roles 必须是数组。`);
    if (!isoTime(entry?.decided_at)) addUniqueError(errors, `${label}.decided_at 必须是 ISO 时间。`);
    else {
      const currentDecisionTime = Date.parse(entry.decided_at);
      if (currentDecisionTime < previousDecisionTime) addUniqueError(errors, `${label}.decided_at 必须随 append-only sequence 单调不减。`);
      if (currentDecisionTime > now) addUniqueError(errors, `${label}.decided_at 位于未来。`);
      previousDecisionTime = Math.max(previousDecisionTime, currentDecisionTime);
    }
    if (entry?.valid_until !== null && !isoTime(entry?.valid_until)) addUniqueError(errors, `${label}.valid_until 必须为 ISO 时间或 null。`);
    if (isoTime(entry?.decided_at) && isoTime(entry?.valid_until) && Date.parse(entry.valid_until) <= Date.parse(entry.decided_at)) {
      addUniqueError(errors, `${label}.valid_until 必须晚于 decided_at。`);
    }
    requireObject(errors, entry?.subject, `${label}.subject`);
    if (!Array.isArray(entry?.evidence_refs)) addUniqueError(errors, `${label}.evidence_refs 必须是数组。`);
    for (const duplicate of duplicateValues(asArray(entry?.evidence_refs).map((item) => item?.id))) addUniqueError(errors, `${id} 重复引用 Evidence ${duplicate}。`);
    for (const [referenceIndex, reference] of asArray(entry?.evidence_refs).entries()) {
      requireString(errors, reference?.id, `${label}.evidence_refs[${referenceIndex}].id`);
      if (!DIGEST_RE.test(String(reference?.digest ?? ""))) addUniqueError(errors, `${label}.evidence_refs[${referenceIndex}].digest 必须是 sha256。`);
      if (!evidenceMap.has(reference?.id)) addUniqueError(errors, `${id} 引用了不存在的 Evidence ${reference?.id}。`);
    }
    const authorization = requireObject(errors, entry?.authorization, `${label}.authorization`);
    for (const field of ["instances", "repositories", "paths", "base_refs", "allowed_actions", "excluded_actions", "stop_conditions", "required_evidence", "reauthorize_on"]) {
      if (!Array.isArray(authorization[field])) addUniqueError(errors, `${label}.authorization.${field} 必须是数组。`);
    }
    for (const [pathIndex, scopedPath] of asArray(authorization.paths).entries()) {
      requireString(errors, scopedPath?.repository, `${label}.authorization.paths[${pathIndex}].repository`);
      if (!validRepositoryScopePath(scopedPath?.path)) addUniqueError(errors, `${label}.authorization.paths[${pathIndex}].path 必须是安全的 repo 内相对路径。`);
    }
    for (const field of ["allowed_actions", "excluded_actions"]) {
      for (const [capabilityIndex, capability] of asArray(authorization[field]).entries()) {
        requireEnum(errors, capability, policy.enums?.authorization_capabilities ?? [], `${label}.authorization.${field}[${capabilityIndex}]`);
      }
    }
    if (!isObject(authorization.budget)) addUniqueError(errors, `${label}.authorization.budget 必须是 object。`);
    for (const duplicate of duplicateValues(asArray(entry?.subject?.artifact_refs).map((item) => item?.id))) addUniqueError(errors, `${id} 的 subject.artifact_refs ID 重复：${duplicate}`);
    requireString(errors, entry?.rationale, `${label}.rationale`);
    if (entry?.supersedes !== null && typeof entry?.supersedes !== "string") addUniqueError(errors, `${label}.supersedes 必须为 string 或 null。`);

    if (GLOBAL_GATES.includes(entry?.gate) && entry?.instance !== "feature") addUniqueError(errors, `${entry?.gate} 的 instance 必须是 feature。`);
    if (entry?.gate === "G2C" && !/^BND-[0-9]{3,}$/.test(String(entry?.instance ?? ""))) addUniqueError(errors, "G2C instance 必须是 BND-NNN。 ");
    if (entry?.gate === "G3" && !/^SLC-[0-9]{3,}$/.test(String(entry?.instance ?? ""))) addUniqueError(errors, "G3 instance 必须是 SLC-NNN。 ");
    if (entry?.gate === "G2C" && !asArray(manifest.boundaries).some((item) => item.id === entry?.instance)) addUniqueError(errors, `${id} 引用了不存在的 Boundary instance ${entry?.instance}。`);
    if (entry?.gate === "G3" && !asArray(manifest.slices).some((item) => item.id === entry?.instance)) addUniqueError(errors, `${id} 引用了不存在的 Slice instance ${entry?.instance}。`);
    const targetPolicy = policy.delivery_targets?.[manifest.feature?.delivery_target];
    if (asArray(targetPolicy?.policy_not_applicable_gates).includes(entry?.gate)) {
      addUniqueError(errors, `${id} 为 policy 派生 not_applicable Gate ${entry.gate} 写入了 Decision；该 Gate 不得存在任何包内决策记录。`);
    }

    const key = `${entry?.gate}:${entry?.instance}`;
    const previous = latest.get(key);
    if (previous && entry?.supersedes !== previous.id) addUniqueError(errors, `${id} 必须以 supersedes=${previous.id} 串联同一 Gate 实例。`);
    if (!previous && entry?.supersedes !== null) addUniqueError(errors, `${id} 是该 Gate 实例首条记录，supersedes 必须为 null。`);
    if (id) {
      byId.set(id, entry);
      latest.set(key, entry);
    }
  }
  return { byId, latest };
}

function referencedEvidence(decision, evidenceMap) {
  return asArray(decision?.evidence_refs).map((reference) => ({ reference, evidence: evidenceMap.get(reference.id) }));
}

function validateRecordedPassedApprovals(decisions, manifest, evidenceMap, approvalTrustRoot, errors) {
  for (const decision of decisions.byId.values()) {
    if (decision?.state !== "passed") continue;
    const approval = verifyApprovalAttestation({
      manifest,
      decision,
      trustRoot: approvalTrustRoot,
      requireCurrentValidity: false,
    });
    for (const reason of approval.reasons) addUniqueError(errors, `历史 passed Decision ${decision.id} 验签失败：${reason}`);
    for (const reference of asArray(decision.evidence_refs)) {
      const record = evidenceMap.get(reference.id);
      if (!record) addUniqueError(errors, `历史 passed Decision ${decision.id} 引用缺失 Evidence ${reference.id}`);
      else if (reference.digest !== record.digest) addUniqueError(errors, `历史 passed Decision ${decision.id} 引用的 Evidence ${reference.id} 摘要已变化`);
    }
  }
}

function mergePolicy(base, override) {
  const merged = { ...base, ...override };
  for (const key of ["required_evidence_kinds", "required_roles_any", "required_reauthorize_on", "required_excluded_actions", "required_allowed_actions", "permitted_capabilities", "prohibited_capabilities", "authorization_fields"]) {
    merged[key] = [...new Set([...asArray(base?.[key]), ...asArray(override?.[key])])];
  }
  merged.required_evidence_groups = [...new Map([...asArray(base?.required_evidence_groups), ...asArray(override?.required_evidence_groups)]
    .map((group) => [JSON.stringify(group), group])).values()];
  return merged;
}

function effectiveGatePolicy(policy, manifest, gate) {
  const profileOverride = policy.profile_overrides?.[manifest.feature?.profile]?.gates?.[gate] ?? {};
  const classificationOverride = policy.classification_overrides?.[manifest.classification?.data]?.gates?.[gate] ?? {};
  return mergePolicy(mergePolicy(policy.gates?.[gate] ?? {}, profileOverride), classificationOverride);
}

function currentDigest(digests, name, instance) {
  if (name === "boundary_digest") return digests.boundary_digests?.[instance] ?? null;
  if (name === "slice_digest") return digests.slice_digests?.[instance] ?? null;
  return digests[name] ?? null;
}

function sameRefs(left, right) {
  const normalize = (items) => asArray(items).map((item) => stableValue(item)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function decisionValidity(decision, gatePolicy, context) {
  const reasons = [];
  if (!decision) return { valid: false, stale: false, reasons: ["缺少 Gate 决策记录"] };
  if (decision.state !== "passed") return { valid: false, stale: false, reasons: [`最新决策状态为 ${decision.state}`] };
  const requiredRoles = asArray(gatePolicy.required_roles_any);
  if (requiredRoles.length > 0 && !asArray(decision.roles).some((role) => requiredRoles.includes(role))) reasons.push(`批准角色不满足：需要 ${requiredRoles.join(" | ")}`);
  if (gatePolicy.human_actor_required && decision.actor?.type !== "human") reasons.push("该 Gate 必须由 human actor 批准");
  const assignment = asArray(context.manifest.feature?.owners?.role_assignments).find((item) => item.actor === decision.actor?.id);
  if (!assignment) reasons.push(`actor ${decision.actor?.id ?? "UNKNOWN"} 未登记在 feature.owners.role_assignments`);
  else for (const role of asArray(decision.roles)) if (!asArray(assignment.roles).includes(role)) reasons.push(`actor ${decision.actor.id} 未获分配角色 ${role}`);
  const approval = verifyApprovalAttestation({
    manifest: context.manifest,
    decision,
    trustRoot: context.approvalTrustRoot,
    now: context.now,
  });
  if (!approval.valid) reasons.push(...approval.reasons);
  if (decision.subject?.policy_digest !== context.digests.policy_digest) reasons.push("subject.policy_digest 与 Feature Package 的内容寻址 gate policy 不一致");
  if (gatePolicy.valid_until_required && !decision.valid_until) reasons.push("该 Gate 必须设置 valid_until");
  if (isoTime(decision.decided_at) && Date.parse(decision.decided_at) > context.now) reasons.push("decided_at 位于未来");
  if (decision.valid_until && isoTime(decision.decided_at) && Date.parse(decision.valid_until) <= Date.parse(decision.decided_at)) reasons.push("valid_until 必须晚于 decided_at");
  if (decision.valid_until && Date.parse(decision.valid_until) <= context.now) reasons.push(`批准已于 ${decision.valid_until} 过期`);
  if (decision.valid_until && isoTime(decision.decided_at) && gatePolicy.maximum_validity_hours && Date.parse(decision.valid_until) - Date.parse(decision.decided_at) > gatePolicy.maximum_validity_hours * 60 * 60 * 1000) {
    reasons.push(`批准有效期超过 ${gatePolicy.maximum_validity_hours} 小时策略上限`);
  }
  const retentionDeadline = decision.valid_until && isoTime(decision.valid_until)
    ? Math.max(context.now, Date.parse(decision.valid_until))
    : context.now;
  for (const digestName of asArray(gatePolicy.subject_digests)) {
    if (decision.subject?.[digestName] !== currentDigest(context.digests, digestName, decision.instance)) reasons.push(`${digestName} 与当前 Package/instance 不一致`);
  }
  for (const field of asArray(gatePolicy.subject_fields)) {
    const value = decision.subject?.[field];
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0) || value === "") reasons.push(`subject.${field} 缺失`);
  }
  for (const [index, codeRef] of asArray(decision.subject?.code_refs).entries()) {
    if (!codeRef?.repository || !SHA_RE.test(String(codeRef?.sha ?? "")) || !SHA_RE.test(String(codeRef?.base_sha ?? ""))) reasons.push(`subject.code_refs[${index}] 必须包含 repository、完整 40 或 64 位 sha 与 base_sha`);
  }
  for (const [index, artifactRef] of asArray(decision.subject?.artifact_refs).entries()) {
    if (!artifactRef?.id || !DIGEST_RE.test(String(artifactRef?.digest ?? ""))) reasons.push(`subject.artifact_refs[${index}] 必须包含 id 与 sha256 digest`);
  }
  const engineeringDecisionRef = decision.subject?.engineering_decision_ref;
  if (engineeringDecisionRef !== null && engineeringDecisionRef !== undefined
    && (!isObject(engineeringDecisionRef) || typeof engineeringDecisionRef.id !== "string" || !DIGEST_RE.test(String(engineeringDecisionRef.digest ?? "")))) {
    reasons.push("subject.engineering_decision_ref 必须为 null 或 {id,digest}");
  }
  const evidence = referencedEvidence(decision, context.evidenceMap);
  for (const { reference, evidence: record } of evidence) {
    if (!record) continue;
    if (reference.digest !== record.digest) reasons.push(`Evidence ${reference.id} 摘要已变化`);
    if (record.execution?.result !== "passed" || record.execution?.exit_code !== 0) reasons.push(`Evidence ${reference.id} 不是成功执行结果`);
    if (isoTime(decision.decided_at) && isoTime(record.recorded_at) && Date.parse(record.recorded_at) > Date.parse(decision.decided_at)) reasons.push(`Evidence ${reference.id} 晚于批准时间`);
    if (!asArray(record.artifacts).some((artifact) => isoTime(artifact.retention_until) && Date.parse(artifact.retention_until) >= retentionDeadline)) reasons.push(`Evidence ${reference.id} 的 artifact 保留期未覆盖 Decision 有效窗口`);
  }
  const validEvidenceRecords = evidence
    .filter(({ reference, evidence: record }) => record && reference.digest === record.digest && record.execution?.result === "passed" && record.execution?.exit_code === 0
      && asArray(record.artifacts).some((artifact) => isoTime(artifact.retention_until) && Date.parse(artifact.retention_until) >= retentionDeadline))
    .map(({ evidence: record }) => record);
  const instanceScopedKinds = new Set(["baseline", "boundary_validation", "review", "static_analysis", "security_review", "data_review", "release_artifact", "rollback_rehearsal", "release_execution", "smoke", "observation", "owner_acceptance", "outcome_metric"]);
  const evidenceMatches = (record, kind, group = false) => {
    if (record.kind !== kind) return false;
    if (decision.gate === "G2C" || decision.gate === "G3") return record.subject?.instance === decision.instance;
    if (group && decision.gate === "G6") return record.subject?.instance === "feature";
    if (instanceScopedKinds.has(kind)) return record.subject?.instance === decision.instance;
    return true;
  };
  for (const codeRef of asArray(decision.subject?.code_refs)) {
    const allowedKinds = decision.gate === "G3" ? TEST_EVIDENCE : decision.gate === "G4" ? new Set(["review"]) : null;
    if (codeRef?.repository && SHA_RE.test(String(codeRef?.sha ?? "")) && SHA_RE.test(String(codeRef?.base_sha ?? "")) && !validEvidenceRecords.some((record) => (!allowedKinds || allowedKinds.has(record.kind))
      && record.subject?.repository === codeRef.repository && record.subject?.code_sha === codeRef.sha && record.subject?.base_sha === codeRef.base_sha)) {
      reasons.push(`code_ref ${codeRef.repository}@${codeRef.sha} base=${codeRef.base_sha} 未逐仓绑定到引用的成功 Evidence`);
    }
  }
  for (const artifactRef of asArray(decision.subject?.artifact_refs)) {
    if (artifactRef?.id && DIGEST_RE.test(String(artifactRef?.digest ?? "")) && !validEvidenceRecords.some((record) => asArray(record.artifacts).some((artifact) => artifact.digest === artifactRef.digest))) {
      reasons.push(`artifact_ref ${artifactRef.id}@${artifactRef.digest} 未绑定到引用的成功 Evidence`);
    }
  }
  const codeScopedEvidenceKinds = new Set(["static_analysis", "review", "security_review", "data_review"]);
  for (const kind of asArray(gatePolicy.required_evidence_kinds)) {
    if (codeScopedEvidenceKinds.has(kind) && (decision.gate === "G3" || decision.gate === "G4")) {
      for (const codeRef of asArray(decision.subject?.code_refs)) {
        if (!validEvidenceRecords.some((record) => evidenceMatches(record, kind)
          && record.subject?.repository === codeRef.repository
          && record.subject?.code_sha === codeRef.sha
          && record.subject?.base_sha === codeRef.base_sha)) {
          reasons.push(`缺少逐仓精确绑定 ${codeRef.repository}@${codeRef.sha} base=${codeRef.base_sha} 的成功 Evidence kind=${kind}`);
        }
      }
    } else if (!validEvidenceRecords.some((record) => evidenceMatches(record, kind))) reasons.push(`缺少当前 instance 的成功 Evidence kind=${kind}`);
  }
  for (const group of asArray(gatePolicy.required_evidence_groups)) if (!asArray(group).some((kind) => validEvidenceRecords.some((record) => evidenceMatches(record, kind, true)))) reasons.push(`缺少当前 subject 的成功 Evidence（${asArray(group).join(" | ")}）`);
  if (decision.gate === "G4") {
    for (const codeRef of asArray(decision.subject?.code_refs)) {
      if (!validEvidenceRecords.some((record) => TEST_EVIDENCE.has(record.kind)
        && record.subject?.repository === codeRef.repository
        && record.subject?.code_sha === codeRef.sha
        && record.subject?.base_sha === codeRef.base_sha)) {
        reasons.push(`G4 缺少逐仓精确绑定 ${codeRef.repository}@${codeRef.sha} base=${codeRef.base_sha} 的最终测试 Evidence`);
      }
    }
  }
  if (decision.gate === "G2") {
    const referencedIds = new Set(asArray(decision.evidence_refs).map((item) => item.id));
    for (const repository of asArray(context.manifest.repositories)) if (!referencedIds.has(repository.baseline?.evidence_id)) reasons.push(`G2 未引用当前 baseline Evidence：${repository.id}`);
    for (const dependency of asArray(context.manifest.dependencies)) if (dependency.status !== "unresolved" && !referencedIds.has(dependency.evidence_id)) reasons.push(`G2 未引用当前依赖 Evidence：${dependency.id}`);
    const rootScopedRepositories = new Set(asArray(context.manifest.slices).flatMap((slice) => asArray(slice.paths))
      .filter((item) => item?.path === ".").map((item) => item.repository));
    const exceptionRequired = context.manifest.feature?.profile === "controlled" || ["high", "critical"].includes(context.manifest.classification?.risk);
    for (const repositoryId of rootScopedRepositories) {
      const repository = asArray(context.manifest.repositories).find((item) => item.id === repositoryId);
      if (!repository?.root_scope_justification) reasons.push(`G2 整仓 scope ${repositoryId} 缺少显式 justification`);
      if (exceptionRequired) {
        const exceptionId = repository?.root_scope_exception_evidence_id;
        if (!exceptionId || !referencedIds.has(exceptionId) || !validEvidenceRecords.some((record) => record.id === exceptionId && record.kind === "exception" && record.subject?.instance === repositoryId)) {
          reasons.push(`G2 ${repositoryId} 的 controlled/high-risk 整仓 scope 必须引用逐仓成功 exception Evidence`);
        }
      }
    }
  }
  if (decision.gate === "G3" || decision.gate === "G4") {
    const expectedRepositories = decision.gate === "G3"
      ? asArray(context.manifest.slices).find((item) => item.id === decision.instance)?.repositories ?? []
      : asArray(context.manifest.repositories).map((item) => item.id);
    const actualRepositories = asArray(decision.subject?.code_refs).map((item) => item.repository);
    if (!sameRefs(expectedRepositories, actualRepositories) || duplicateValues(actualRepositories).length > 0) reasons.push(`subject.code_refs 必须精确覆盖 ${decision.gate === "G3" ? decision.instance : "全部实现仓库"}：${expectedRepositories.join(", ")}`);
    for (const repository of actualRepositories) if (!asArray(context.manifest.repositories).some((item) => item.id === repository)) reasons.push(`subject.code_refs 含未知 repository ${repository}`);
  }
  if (decision.gate === "G3") {
    const slice = asArray(context.manifest.slices).find((item) => item.id === decision.instance);
    const covered = new Set(validEvidenceRecords.filter((record) => TEST_EVIDENCE.has(record.kind) && record.subject?.instance === decision.instance)
      .flatMap((record) => asArray(record.subject?.acceptance_criteria)));
    for (const criterion of asArray(slice?.acceptance_criteria)) if (!covered.has(criterion)) reasons.push(`${decision.instance} 的测试 Evidence 未覆盖 ${criterion}`);
  }
  const releaseKinds = new Set(["release_artifact", "rollback_rehearsal", "release_execution", "smoke", "observation", "owner_acceptance", "outcome_metric"]);
  if (decision.gate === "G5" || decision.gate === "G6") {
    const g4 = context.currentG4;
    const expectedEngineeringRef = g4 ? { id: g4.id, digest: recordDigest(g4) } : null;
    if (!g4 || g4.state !== "passed") reasons.push(`${decision.gate} 缺少当前 passed G4`);
    else {
      if (!sameRefs(decision.subject?.code_refs, g4.subject?.code_refs)) reasons.push(`${decision.gate} code_refs 必须精确继承当前 G4`);
      if (JSON.stringify(stableValue(decision.subject?.engineering_decision_ref)) !== JSON.stringify(stableValue(expectedEngineeringRef))) reasons.push(`${decision.gate} engineering_decision_ref 必须精确绑定当前 G4 Decision`);
      if (decision.gate === "G5" && isoTime(g4.decided_at) && isoTime(decision.decided_at) && Date.parse(decision.decided_at) <= Date.parse(g4.decided_at)) reasons.push("G5 decided_at 必须晚于当前 G4");
    }
    if (decision.subject?.environment_ref !== context.manifest.feature?.delivery_target) reasons.push(`subject.environment_ref 必须等于 delivery_target=${context.manifest.feature?.delivery_target}`);
    for (const record of validEvidenceRecords.filter((item) => releaseKinds.has(item.kind))) if (record.subject?.environment_ref !== decision.subject?.environment_ref) reasons.push(`Evidence ${record.id} 环境与 Gate subject 不一致`);
    const artifactCarrierKinds = decision.gate === "G6" ? new Set(["release_execution"]) : new Set(["release_artifact"]);
    for (const artifactRef of asArray(decision.subject?.artifact_refs)) if (!validEvidenceRecords.some((record) => artifactCarrierKinds.has(record.kind) && asArray(record.artifacts).some((artifact) => artifact.digest === artifactRef.digest))) reasons.push(`${decision.gate} artifact_ref ${artifactRef.id} 未被目标环境的发布 Evidence 绑定`);
  }
  if (decision.gate === "G5" && !validEvidenceRecords.some((record) => record.kind === "rollback_rehearsal" && record.id === decision.subject?.rollback_ref)) reasons.push("G5 rollback_ref 必须指向本次引用的 rollback_rehearsal Evidence");
  if (decision.gate === "G5") {
    for (const codeRef of asArray(decision.subject?.code_refs)) {
      if (!validEvidenceRecords.some((record) => record.kind === "release_artifact"
        && record.subject?.repository === codeRef.repository
        && record.subject?.code_sha === codeRef.sha
        && record.subject?.base_sha === codeRef.base_sha
        && sameRefs(record.subject?.artifact_refs, decision.subject?.artifact_refs))) {
        reasons.push(`G5 缺少逐仓绑定 ${codeRef.repository}@${codeRef.sha} base=${codeRef.base_sha} 与当前制品的 release_artifact provenance`);
      }
    }
    const account = decision.authorization?.account;
    if (decision.subject?.account_ref !== account) reasons.push("G5 subject.account_ref 必须精确绑定 authorization.account");
    for (const kind of asArray(gatePolicy.account_bound_evidence_kinds)) {
      const records = validEvidenceRecords.filter((record) => record.kind === kind);
      for (const record of records) {
        if (record.subject?.account_ref !== account) reasons.push(`G5 Evidence ${record.id} 未绑定 authorization.account=${account}`);
        if (!sameRefs(record.subject?.artifact_refs, decision.subject?.artifact_refs)) reasons.push(`G5 Evidence ${record.id} 未绑定当前 release artifact_refs`);
      }
    }
  }
  if (decision.gate === "G6") {
    const g5 = context.currentG5;
    const g5Time = isoTime(g5?.decided_at) ? Date.parse(g5.decided_at) : null;
    const expectedCriteria = asArray(context.manifest.acceptance_criteria).map((criterion) => criterion.id);
    for (const kind of asArray(gatePolicy.post_g5_evidence_kinds)) {
      const records = validEvidenceRecords.filter((record) => record.kind === kind);
      if (records.length === 0) continue;
      const covered = new Set(records.flatMap((record) => asArray(record.subject?.acceptance_criteria)));
      for (const criterion of expectedCriteria) if (!covered.has(criterion)) reasons.push(`G6 ${kind} Evidence 未覆盖 acceptance criterion ${criterion}`);
      for (const record of records) {
        if (g5Time === null || !isoTime(record.execution?.started_at) || Date.parse(record.execution.started_at) <= g5Time) reasons.push(`G6 Evidence ${record.id} 的执行时间必须晚于当前 G5 决策`);
        if (record.subject?.environment_ref !== g5?.subject?.environment_ref) reasons.push(`G6 Evidence ${record.id} 未延续 G5 environment_ref`);
        if (record.subject?.account_ref !== g5?.subject?.account_ref) reasons.push(`G6 Evidence ${record.id} 未延续 G5 account_ref`);
        if (!sameRefs(record.subject?.artifact_refs, g5?.subject?.artifact_refs)) reasons.push(`G6 Evidence ${record.id} 未延续 G5 artifact_refs`);
      }
    }
    for (const rule of asArray(gatePolicy.post_g5_evidence_order)) {
      const beforeRecords = validEvidenceRecords.filter((record) => record.kind === rule?.before);
      const afterRecords = validEvidenceRecords.filter((record) => asArray(rule?.after).includes(record.kind));
      for (const before of beforeRecords) {
        for (const after of afterRecords) {
          if (isoTime(before.execution?.finished_at) && isoTime(after.execution?.started_at)
            && Date.parse(before.execution.finished_at) > Date.parse(after.execution.started_at)) {
            reasons.push(`G6 Evidence 时间顺序无效：${before.id}.finished_at 必须不晚于 ${after.id}.started_at`);
          }
        }
      }
    }
  }
  if (gatePolicy.authorization_required) {
    if (asArray(decision.authorization?.instances).length === 0) reasons.push(`${decision.gate} Authorization 必须限定至少一个实例`);
    if (asArray(decision.authorization?.allowed_actions).length === 0) reasons.push(`${decision.gate} Authorization 必须声明 allowed_actions`);
    if (asArray(decision.authorization?.reauthorize_on).length === 0) reasons.push(`${decision.gate} Authorization 必须声明 reauthorize_on`);
    const allowed = new Set(asArray(decision.authorization?.allowed_actions));
    const excluded = new Set(asArray(decision.authorization?.excluded_actions));
    const reauthorizeOn = new Set(asArray(decision.authorization?.reauthorize_on));
    const permitted = new Set(asArray(gatePolicy.permitted_capabilities));
    for (const action of allowed) if (!permitted.has(action)) reasons.push(`${decision.gate} capability ${action} 不在策略允许集合内`);
    for (const action of asArray(gatePolicy.prohibited_capabilities)) if (allowed.has(action)) reasons.push(`${decision.gate} 不得授权被策略禁止的 capability ${action}`);
    for (const action of allowed) if (excluded.has(action)) reasons.push(`${decision.gate} authorization 同时允许并排除动作 ${action}`);
    for (const action of asArray(gatePolicy.required_excluded_actions)) if (!excluded.has(action)) reasons.push(`${decision.gate} 必须显式排除 capability ${action}`);
    for (const trigger of asArray(gatePolicy.required_reauthorize_on)) if (!reauthorizeOn.has(trigger)) reasons.push(`${decision.gate} reauthorize_on 缺少 ${trigger}`);
    for (const action of asArray(gatePolicy.required_allowed_actions)) if (!allowed.has(action)) reasons.push(`${decision.gate} allowed_actions 缺少 ${action}`);
    for (const field of ["instances", "repositories", "allowed_actions", "excluded_actions", "stop_conditions", "required_evidence", "reauthorize_on"]) {
      for (const value of asArray(decision.authorization?.[field])) if (typeof value !== "string" || value.trim() === "") reasons.push(`${decision.gate} authorization.${field} 含空值`);
    }
    for (const required of asArray(gatePolicy.authorization_required_evidence)) if (!asArray(decision.authorization?.required_evidence).includes(required)) reasons.push(`${decision.gate} authorization.required_evidence 缺少 ${required}`);
    for (const field of asArray(gatePolicy.authorization_fields)) {
      const value = decision.authorization?.[field];
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0)) reasons.push(`${decision.gate} authorization.${field} 缺失`);
    }
    if (decision.authorization?.data_classification !== context.manifest.classification?.data) reasons.push(`${decision.gate} authorization.data_classification 与 manifest 不一致`);
    if (decision.gate === "G2") {
      const expectedInstances = asArray(context.manifest.slices).map((item) => item.id);
      const expectedRepositories = [...new Set(asArray(context.manifest.slices).flatMap((item) => asArray(item.repositories)))];
      const expectedPaths = [...new Map(asArray(context.manifest.slices).flatMap((item) => asArray(item.paths))
        .map((item) => [`${item.repository}\0${item.path}`, { repository: item.repository, path: item.path }])).values()];
      if (!sameRefs(expectedInstances, decision.authorization.instances)) reasons.push("G2 authorization.instances 必须精确覆盖全部 Slice");
      if (!sameRefs(expectedRepositories, decision.authorization.repositories)) reasons.push("G2 authorization.repositories 必须精确覆盖 Slice 使用的实现仓库");
      if (!sameRefs(expectedPaths, decision.authorization.paths)) reasons.push("G2 authorization.paths 必须以 repository/path 结构精确覆盖全部 Slice scope");
      const expectedBaseRefs = asArray(context.manifest.repositories).filter((item) => expectedRepositories.includes(item.id)).map((item) => ({ repository: item.id, sha: item.baseline?.sha }));
      if (!sameRefs(expectedBaseRefs, decision.authorization.base_refs)) reasons.push("G2 authorization.base_refs 与当前逐仓 baseline 不一致");
      if (decision.authorization.environment !== "local_engineering") reasons.push("G2 authorization.environment 必须是 local_engineering");
      if (decision.authorization.account !== null) reasons.push("G2 authorization.account 必须是 null；真实目标账号只能由 G5 授权");
    }
    if (decision.gate === "G5") {
      if (decision.authorization.environment !== context.manifest.feature?.delivery_target) reasons.push("G5 authorization.environment 必须等于 delivery_target");
      if (typeof decision.authorization.account !== "string" || decision.authorization.account.trim() === "") reasons.push("G5 authorization.account 必须绑定目标账号");
      if (typeof decision.authorization.budget?.currency !== "string" || !Number.isFinite(decision.authorization.budget?.maximum)) reasons.push("G5 authorization.budget 必须给出 currency 与 maximum");
    }
  }
  return { valid: reasons.length === 0, stale: reasons.some((reason) => /摘要|过期|不一致|已变化/.test(reason)), reasons };
}

function buildEvaluator(manifest, policy, evidenceMap, decisions, digests, approvalTrustRoot, structuralErrors, completionErrors) {
  const feature = manifest.feature ?? {};
  const boundaries = asArray(manifest.boundaries);
  const slices = asArray(manifest.slices);
  const targetPolicy = policy.delivery_targets?.[feature.delivery_target];
  const cache = new Map();
  const now = Date.now();

  function policyNotApplicable(gate, instance) {
    return gateExists(gate, instance) && asArray(targetPolicy?.policy_not_applicable_gates).includes(gate);
  }

  function gateExists(gate, instance) {
    const scope = policy.gates?.[gate]?.scope;
    if (scope === "feature") return instance === "feature";
    if (scope === "boundary") return boundaries.some((boundary) => boundary.id === instance);
    if (scope === "slice") return slices.some((slice) => slice.id === instance);
    return false;
  }

  function prerequisites(gate, instance) {
    const result = [];
    const slice = slices.find((item) => item.id === instance);
    for (const prerequisite of asArray(policy.gates?.[gate]?.prerequisites)) {
      const scope = policy.gates?.[prerequisite]?.scope;
      if (scope === "feature") result.push([prerequisite, "feature"]);
      else if (scope === "boundary" && gate === "G3") result.push(...asArray(slice?.boundary_ids).map((id) => [prerequisite, id]));
      else if (scope === "boundary" && gate === "G4") result.push(...boundaries.map((item) => [prerequisite, item.id]));
      else if (scope === "slice" && gate === "G3") result.push(...asArray(slice?.depends_on).map((id) => [prerequisite, id]));
      else if (scope === "slice" && gate === "G4") result.push(...slices.map((item) => [prerequisite, item.id]));
    }
    return result;
  }

  function evidenceAvailable(kind, instance = null) {
    return [...evidenceMap.values()].some((entry) => entry.kind === kind && entry.execution?.result === "passed" && entry.execution?.exit_code === 0 && (instance === null || entry.subject?.instance === instance));
  }

  function readiness(gate, instance) {
    const reasons = [];
    if (structuralErrors.length > 0) reasons.push("Package 结构或策略校验失败");
    reasons.push(...asArray(completionErrors?.[gate]), ...asArray(completionErrors?.[`${gate}:${instance}`]));
    for (const [preGate, preInstance] of prerequisites(gate, instance)) {
      const result = evaluate(preGate, preInstance);
      if (result.state !== "passed" && result.state !== "not_applicable") reasons.push(`前置 ${preGate}/${preInstance} 未通过（${result.state}）`);
    }
    if (gate === "G2") {
      for (const repository of asArray(manifest.repositories)) {
        if (!repository.baseline?.sha || !repository.baseline?.evidence_id) reasons.push(`${repository.id} 尚未登记 baseline SHA/Evidence`);
        const record = evidenceMap.get(repository.baseline?.evidence_id);
        if (!record || record.kind !== "baseline" || record.execution?.result !== "passed" || record.subject?.code_sha !== repository.baseline?.sha) reasons.push(`${repository.id} baseline Evidence 无效或与 SHA 不一致`);
      }
      for (const dependency of asArray(manifest.dependencies)) if (dependency.status === "unresolved") reasons.push(`依赖 ${dependency.id} 尚未解决`);
    }
    if (gate === "G2C" && !evidenceAvailable("boundary_validation", instance)) reasons.push(`${instance} 缺少 boundary_validation Evidence`);
    if (gate === "G3") {
      const slice = slices.find((item) => item.id === instance);
      const authorization = decisions.byId.get(slice?.authorization_decision_id);
      const currentAuthorization = decisions.latest.get("G2:feature");
      const authValidity = decisionValidity(authorization, effectiveGatePolicy(policy, manifest, "G2"), { now, digests, evidenceMap, manifest, approvalTrustRoot });
      if (!authorization || authorization !== currentAuthorization || authorization.gate !== "G2" || authorization.instance !== "feature" || !authValidity.valid || !asArray(authorization.authorization?.instances).includes(instance)) {
        reasons.push(`${instance} 缺少有效且覆盖本实例的 G2 Authorization`);
      }
      if (![...evidenceMap.values()].some((entry) => TEST_EVIDENCE.has(entry.kind) && entry.execution?.result === "passed" && entry.execution?.exit_code === 0 && entry.subject?.instance === instance)) reasons.push(`${instance} 缺少成功测试 Evidence`);
    }
    if (gate === "G4") {
      if (!evidenceAvailable("review", "feature")) reasons.push("缺少 feature 级 review Evidence");
      if (![...evidenceMap.values()].some((entry) => TEST_EVIDENCE.has(entry.kind) && entry.execution?.result === "passed" && entry.execution?.exit_code === 0)) reasons.push("缺少成功测试 Evidence");
    }
    if (gate === "G5") {
      if (!evidenceAvailable("release_artifact", "feature")) reasons.push("缺少 release_artifact Evidence");
      if (!evidenceAvailable("rollback_rehearsal", "feature")) reasons.push("缺少 rollback_rehearsal Evidence");
    }
    if (gate === "G6") {
      for (const kind of ["release_execution", "smoke", "observation"]) if (!evidenceAvailable(kind, "feature")) reasons.push(`缺少 ${kind} Evidence`);
      if (!evidenceAvailable("owner_acceptance", "feature") && !evidenceAvailable("outcome_metric", "feature")) reasons.push("缺少 owner_acceptance 或 outcome_metric Evidence");
    }
    return { eligibility: reasons.length === 0 ? "ELIGIBLE" : "BLOCKED", reasons };
  }

  function evaluate(gate, instance) {
    const key = `${gate}:${instance}`;
    if (cache.has(key)) return cache.get(key);
    if (!gateExists(gate, instance)) {
      const missing = { gate, instance, state: "failed", eligibility: "BLOCKED", decision_id: null, reasons: ["Gate 实例不存在"] };
      cache.set(key, missing);
      return missing;
    }
    if (policyNotApplicable(gate, instance)) {
      const result = { gate, instance, state: "not_applicable", eligibility: "NOT_APPLICABLE", decision_id: null, reasons: [`delivery_target=${feature.delivery_target} 在 ${targetPolicy.terminal_gate} 终止`] };
      cache.set(key, result);
      return result;
    }

    // Put a temporary entry in the cache to make malformed prerequisite cycles fail closed.
    cache.set(key, { gate, instance, state: "failed", eligibility: "BLOCKED", decision_id: null, reasons: ["Gate 前置关系形成环"] });
    const ready = readiness(gate, instance);
    const decision = decisions.latest.get(key);
    let state = decision?.state ?? "pending";
    const reasons = [...ready.reasons];
    if (decision?.state === "passed") {
      const validity = decisionValidity(decision, effectiveGatePolicy(policy, manifest, gate), {
        now,
        digests,
        evidenceMap,
        manifest,
        approvalTrustRoot,
        currentG4: gate === "G5" || gate === "G6" ? decisions.latest.get("G4:feature") : null,
        currentG5: gate === "G6" ? decisions.latest.get("G5:feature") : null,
      });
      if (!validity.valid) {
        state = "stale";
        reasons.push(...validity.reasons);
      } else if (ready.eligibility !== "ELIGIBLE") {
        state = "stale";
        reasons.push("批准存在，但当前前置条件已不成立");
      }
      if (gate === "G6") {
        const g5 = decisions.latest.get("G5:feature");
        if (!g5 || g5.state !== "passed"
          || g5.subject?.environment_ref !== decision.subject?.environment_ref
          || g5.subject?.account_ref !== decision.subject?.account_ref
          || !sameRefs(g5.subject?.artifact_refs, decision.subject?.artifact_refs)
          || !sameRefs(g5.subject?.code_refs, decision.subject?.code_refs)
          || JSON.stringify(stableValue(g5.subject?.engineering_decision_ref)) !== JSON.stringify(stableValue(decision.subject?.engineering_decision_ref))) {
          state = "stale";
          reasons.push("G6 必须精确继承当前 G5 的 code_refs、engineering_decision_ref、environment_ref、account_ref 与 artifact_refs");
        }
      }
    }
    if (decision?.state === "not_applicable") {
      state = "failed";
      reasons.push("该 Gate 不能由包内记录自行设为 not_applicable；仅 gate-policy 可裁剪");
    }
    const gatePolicy = effectiveGatePolicy(policy, manifest, gate);
    const digestName = asArray(gatePolicy.subject_digests)[0] ?? null;
    const result = {
      gate,
      instance,
      state,
      eligibility: ready.eligibility,
      decision_id: decision?.id ?? null,
      decision_record_digest: decision ? recordDigest(decision) : null,
      decided_at: decision?.decided_at ?? null,
      subject_digest: digestName ? currentDigest(digests, digestName, instance) : null,
      reasons: [...new Set(reasons)],
    };
    cache.set(key, result);
    return result;
  }

  function allApplicableResults() {
    const results = [];
    for (const gate of Object.keys(policy.gates ?? {}).filter((item) => policy.gates[item]?.scope === "feature")) results.push(evaluate(gate, "feature"));
    for (const boundary of boundaries) results.push(evaluate("G2C", boundary.id));
    for (const slice of slices) results.push(evaluate("G3", slice.id));
    const order = Object.keys(policy.gates ?? {});
    return results.sort((left, right) => order.indexOf(left.gate) - order.indexOf(right.gate) || left.instance.localeCompare(right.instance));
  }

  return { evaluate, allApplicableResults, targetPolicy };
}

function validatePolicy(policy, errors) {
  if (policy?.schema_version !== 2 || policy?.kind !== "FeatureDeliveryPolicy") addUniqueError(errors, "gate-policy.yaml 必须是 v2 FeatureDeliveryPolicy。 ");
  const gateIds = Object.keys(policy?.gates ?? {});
  const capabilityCatalog = new Set(asArray(policy?.enums?.authorization_capabilities));
  for (const required of ALL_GATES) if (!gateIds.includes(required)) addUniqueError(errors, `gate-policy 缺少 ${required}。`);
  for (const [gate, definition] of Object.entries(policy?.gates ?? {})) {
    if (!["feature", "boundary", "slice"].includes(definition?.scope)) addUniqueError(errors, `gate-policy ${gate}.scope 无效。`);
    for (const prerequisite of asArray(definition?.prerequisites)) if (!gateIds.includes(prerequisite)) addUniqueError(errors, `gate-policy ${gate} 引用未知前置 ${prerequisite}。`);
    for (const field of ["required_evidence_kinds", "account_bound_evidence_kinds", "post_g5_evidence_kinds"]) {
      for (const kind of asArray(definition?.[field])) if (!asArray(policy.enums?.evidence_kinds).includes(kind)) addUniqueError(errors, `gate-policy ${gate}.${field} 引用未知 Evidence kind ${kind}。`);
    }
    for (const [index, rule] of asArray(definition?.post_g5_evidence_order).entries()) {
      if (!asArray(policy.enums?.evidence_kinds).includes(rule?.before)) addUniqueError(errors, `gate-policy ${gate}.post_g5_evidence_order[${index}].before 引用未知 Evidence kind ${rule?.before}。`);
      if (asArray(rule?.after).length === 0) addUniqueError(errors, `gate-policy ${gate}.post_g5_evidence_order[${index}].after 不能为空。`);
      for (const kind of asArray(rule?.after)) if (!asArray(policy.enums?.evidence_kinds).includes(kind)) addUniqueError(errors, `gate-policy ${gate}.post_g5_evidence_order[${index}].after 引用未知 Evidence kind ${kind}。`);
    }
    for (const group of asArray(definition?.required_evidence_groups)) {
      for (const kind of asArray(group)) if (!asArray(policy.enums?.evidence_kinds).includes(kind)) addUniqueError(errors, `gate-policy ${gate}.required_evidence_groups 引用未知 Evidence kind ${kind}。`);
    }
    for (const field of ["permitted_capabilities", "prohibited_capabilities", "required_excluded_actions", "required_allowed_actions"]) {
      for (const capability of asArray(definition?.[field])) if (!capabilityCatalog.has(capability)) addUniqueError(errors, `gate-policy ${gate}.${field} 引用未知 capability ${capability}。`);
    }
    const permitted = new Set(asArray(definition?.permitted_capabilities));
    const prohibited = new Set(asArray(definition?.prohibited_capabilities));
    for (const capability of permitted) if (prohibited.has(capability)) addUniqueError(errors, `gate-policy ${gate} 同时允许并禁止 capability ${capability}。`);
    if (definition?.authorization_required) {
      if (permitted.size === 0) addUniqueError(errors, `gate-policy ${gate} 必须声明 permitted_capabilities。`);
      for (const capability of prohibited) if (!asArray(definition?.required_excluded_actions).includes(capability)) addUniqueError(errors, `gate-policy ${gate} prohibited capability ${capability} 必须进入 required_excluded_actions。`);
    }
  }
  for (const [target, definition] of Object.entries(policy?.delivery_targets ?? {})) {
    if (!gateIds.includes(definition?.terminal_gate)) addUniqueError(errors, `delivery_target ${target} terminal_gate 无效。`);
    for (const gate of [...asArray(definition?.required_gates), ...asArray(definition?.policy_not_applicable_gates)]) if (!gateIds.includes(gate)) addUniqueError(errors, `delivery_target ${target} 引用未知 Gate ${gate}。`);
    const required = new Set(asArray(definition?.required_gates));
    const notApplicable = new Set(asArray(definition?.policy_not_applicable_gates));
    for (const gate of required) if (notApplicable.has(gate)) addUniqueError(errors, `delivery_target ${target} 同时要求并裁剪 ${gate}。`);
    for (const gate of gateIds) if (!required.has(gate) && !notApplicable.has(gate)) addUniqueError(errors, `delivery_target ${target} 未声明 ${gate} 为 required 或 policy_not_applicable。`);
    if (!required.has(definition?.terminal_gate)) addUniqueError(errors, `delivery_target ${target} 的 terminal_gate 必须属于 required_gates。`);
  }
}

function computeCompletionErrors(manifest, policy, packageDir) {
  const completion = {};
  for (const [gate, kinds] of Object.entries(policy.artifact_completion ?? {})) {
    const reasons = [];
    for (const artifact of asArray(manifest.artifacts).filter((item) => asArray(kinds).includes(item.kind)
      && !(gate === "G2C" && item.kind === "boundary_spec")
      && item.applicability !== "not_applicable"
      && (item.applicability === "required" || existsSync(resolve(packageDir, String(item.path ?? "")))))) {
      const candidate = resolve(packageDir, String(artifact.path ?? ""));
      if (!pathInside(packageDir, candidate) || !existsSync(candidate)) {
        reasons.push(`${gate} 缺少 artifact ${artifact.path}`);
        continue;
      }
      const pathErrors = [];
      const safePath = safeExistingFile(packageDir, candidate, `artifact ${artifact.id}`, pathErrors);
      reasons.push(...pathErrors);
      if (!safePath) continue;
      const token = readFileSync(safePath, "utf8").match(/\{\{[A-Z0-9_]+\}\}/)?.[0];
      if (token) reasons.push(`${gate} 所需 ${artifact.path} 仍有模板变量 ${token}`);
    }
    completion[gate] = [...new Set(reasons)];
  }
  for (const boundary of asArray(manifest.boundaries)) {
    const reasons = [];
    const artifact = asArray(manifest.artifacts).find((item) => item.id === boundary.artifact_id);
    const candidate = artifact ? resolve(packageDir, String(artifact.path ?? "")) : null;
    if (!artifact || !candidate || !existsSync(candidate)) reasons.push(`G2C/${boundary.id} 缺少独立 boundary_spec`);
    else {
      const pathErrors = [];
      const safePath = safeExistingFile(packageDir, candidate, `artifact ${artifact.id}`, pathErrors);
      reasons.push(...pathErrors);
      if (safePath) {
        const token = readFileSync(safePath, "utf8").match(/\{\{[A-Z0-9_]+\}\}/)?.[0];
        if (token) reasons.push(`G2C/${boundary.id} 的 ${artifact.path} 仍有模板变量 ${token}`);
      }
    }
    completion[`G2C:${boundary.id}`] = [...new Set(reasons)];
  }
  return completion;
}

function parseSummaryFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Delivery Summary 缺少 YAML frontmatter");
  const document = YAML.parseDocument(match[1], { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`Delivery Summary frontmatter 无效：${document.errors.map((item) => item.message).join("; ")}`);
  return { header: document.toJS(), body: source.slice(match[0].length).replace(/^\r?\n/, "") };
}

function validateSummary(manifest, packageDir, evaluator, errors) {
  const summary = asArray(manifest.artifacts).find((artifact) => artifact?.kind === "delivery_summary");
  if (!summary) {
    addUniqueError(errors, "缺少 delivery_summary artifact 声明。 ");
    return;
  }
  const summaryPath = resolve(packageDir, String(summary.path ?? ""));
  if (!pathInside(packageDir, summaryPath) || !existsSync(summaryPath)) {
    addUniqueError(errors, "terminal Gate 后必须 materialize Delivery Summary。 ");
    return;
  }
  const safePath = safeExistingFile(packageDir, summaryPath, "Delivery Summary", errors);
  if (!safePath || statSync(safePath).size === 0) return;
  let header;
  let body;
  try {
    ({ header, body } = parseSummaryFrontmatter(readFileSync(safePath, "utf8")));
  } catch (error) {
    addUniqueError(errors, error.message);
    return;
  }
  if (!isObject(header)) {
    addUniqueError(errors, "Delivery Summary frontmatter 必须是 object。 ");
    return;
  }
  const actualHeaderFields = Object.keys(header).sort();
  const expectedHeaderFields = [...SUMMARY_HEADER_FIELDS].sort();
  if (JSON.stringify(actualHeaderFields) !== JSON.stringify(expectedHeaderFields)) {
    addUniqueError(errors, `Delivery Summary frontmatter 字段必须严格等于：${SUMMARY_HEADER_FIELDS.join(", ")}。`);
  }
  const terminalGate = evaluator.targetPolicy?.terminal_gate;
  const terminal = evaluator.evaluate(terminalGate, "feature");
  const expectedClaim = manifest.feature?.delivery_target === "local_engineering" ? "engineering_complete_not_released" : "target_outcome_verified";
  const expected = {
    schema_version: 2,
    kind: "DeliverySummary",
    feature_id: manifest.feature?.id,
    delivery_target: manifest.feature?.delivery_target,
    terminal_gate: terminalGate,
    terminal_decision_id: terminal.decision_id,
    terminal_decision_digest: terminal.decision_record_digest,
    terminal_subject_digest: terminal.subject_digest,
    delivery_claim: expectedClaim,
  };
  for (const [key, value] of Object.entries(expected)) if (header?.[key] !== value) addUniqueError(errors, `Delivery Summary ${key} 与当前 terminal subject 不一致。`);
  if (!DIGEST_RE.test(String(terminal.decision_record_digest ?? ""))) addUniqueError(errors, "Delivery Summary 无法绑定有效的 terminal Decision record digest。 ");
  if (!DIGEST_RE.test(String(header?.summary_body_digest ?? "")) || header.summary_body_digest !== sha256(body)) addUniqueError(errors, "Delivery Summary 正文摘要不匹配；禁止手工改写机器派生正文。 ");
  if (!isoTime(header?.generated_at)) addUniqueError(errors, "Delivery Summary generated_at 必须是 ISO 时间。 ");
  else {
    if (Date.parse(header.generated_at) > Date.now() + 5 * 60 * 1000) addUniqueError(errors, "Delivery Summary generated_at 位于未来。 ");
    if (isoTime(terminal.decided_at) && Date.parse(header.generated_at) < Date.parse(terminal.decided_at)) addUniqueError(errors, "Delivery Summary 生成时间早于 terminal 决策。 ");
    try {
      const canonicalBody = buildDeliverySummaryBody({
        manifest,
        terminalGate,
        terminalDecisionId: terminal.decision_id,
        terminalDecisionDigest: terminal.decision_record_digest,
        terminalSubjectDigest: terminal.subject_digest,
        deliveryClaim: expectedClaim,
        generatedAt: header.generated_at,
      });
      if (body !== canonicalBody) addUniqueError(errors, "Delivery Summary 正文与当前 manifest/ledger canonical 重建结果不一致。 ");
    } catch (error) {
      addUniqueError(errors, `Delivery Summary canonical 重建失败：${error.message}`);
    }
  }
}

function outputText(report, options) {
  if (report.legacy) {
    const stream = report.recognized && report.verdict === "LEGACY_RECOGNIZED" ? process.stdout : process.stderr;
    stream.write(`${report.verdict}: ${report.package_dir}\n`);
    stream.write(`tree_digest=${report.tree_digest ?? "unavailable"} expected=${report.expected_tree_digest ?? "unregistered"}\n`);
    stream.write("schema v1 只读识别结果始终 valid=false，且不是 Gate PASS。\n");
    for (const error of report.errors ?? []) stream.write(`  - ${error}\n`);
    return;
  }
  if (report.errors.length > 0) {
    process.stderr.write(`INVALID: ${report.package_dir}\n`);
    for (const error of report.errors) process.stderr.write(`  - ${error}\n`);
  } else if (report.verdict === "BLOCKED") {
    process.stdout.write(`BLOCKED: ${report.feature.id} profile=${report.feature.profile} target=${report.feature.delivery_target}\n`);
  } else {
    process.stdout.write(`VALID: ${report.feature.id} profile=${report.feature.profile} target=${report.feature.delivery_target}\n`);
  }
  if (!report.digests) {
    for (const warning of report.warnings ?? []) process.stdout.write(`WARNING: ${warning}\n`);
    return;
  }
  process.stdout.write(`DIGEST intake_digest=${report.digests.intake_digest} scope_digest=${report.digests.scope_digest} build_digest=${report.digests.build_digest}\n`);
  for (const [id, digest] of Object.entries(report.digests.boundary_digests ?? {})) process.stdout.write(`DIGEST boundary_digest/${id}=${digest}\n`);
  for (const [id, digest] of Object.entries(report.digests.slice_digests ?? {})) process.stdout.write(`DIGEST slice_digest/${id}=${digest}\n`);
  process.stdout.write(`DIGEST engineering_digest=${report.digests.engineering_digest} release_digest=${report.digests.release_digest}\n`);
  if (options.gate || options.strict || report.verdict === "BLOCKED") {
    for (const gate of report.gates) {
      process.stdout.write(`GATE ${gate.gate} instance=${gate.instance} state=${gate.state} eligibility=${gate.eligibility} decision=${gate.decision_id ?? "none"}\n`);
      for (const reason of gate.reasons) process.stdout.write(`  - ${reason}\n`);
    }
  }
  for (const warning of report.warnings) process.stdout.write(`WARNING: ${warning}\n`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    usage(2);
  }
  const failPackageRoot = (message) => {
    if (options.json) process.stdout.write(`${JSON.stringify({ valid: false, legacy: false, verdict: "INVALID", package_dir: resolve(options.packageDir), errors: [message], warnings: [], gates: [] }, null, 2)}\n`);
    else process.stderr.write(`ERROR: ${message}\n`);
    process.exit(2);
  };
  if (options.packageDir.includes("\0") || ["", ".", ".."].includes(options.packageDir.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "")) {
    failPackageRoot(`Package 根目录路径段异常：${options.packageDir}`);
  }
  const packageDir = resolve(options.packageDir);
  if (!existsSync(packageDir)) {
    failPackageRoot(`Package 目录不存在：${packageDir}`);
  }
  const packageMetadata = lstatSync(packageDir);
  if (packageMetadata.isSymbolicLink()) {
    failPackageRoot(`Package 根目录不得是符号链接：${packageDir}`);
  }
  if (!packageMetadata.isDirectory()) {
    failPackageRoot(`Package 路径不是目录：${packageDir}`);
  }
  let currentRepositoryRoot;
  let projectContext;
  try {
    currentRepositoryRoot = resolveCurrentRepositoryRoot(options.repositoryRoot, packageDir);
    projectContext = loadProjectContext({
      projectConfig: options.projectConfig,
      repositoryRoot: currentRepositoryRoot,
      startPath: packageDir,
      frameworkDir: FRAMEWORK_DIR,
    });
    options.trustRoot ??= projectContext.governance.trustRoot;
  } catch (error) {
    failPackageRoot(error.message);
  }

  const errors = [];
  const warnings = [];
  let manifestRecord;
  let policyRecord;
  let repositoryRegistry = projectContext.registry;
  let schema;
  try {
    if (!existsSync(SCHEMA_PATH)) throw new Error(`缺少 Schema：${SCHEMA_PATH}`);
    schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const manifestPath = resolve(packageDir, "feature.yaml");
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) throw new Error("feature.yaml 缺失或为不允许的符号链接");
    manifestRecord = parseYaml(manifestPath);
    if (manifestRecord.data?.schema_version === 2) policyRecord = resolveGatePolicy(manifestRecord.data.policy, FRAMEWORK_DIR);
  } catch (error) {
    if (options.json) process.stdout.write(`${JSON.stringify({ valid: false, legacy: false, verdict: "INVALID", package_dir: packageDir, errors: [error.message], warnings: [], gates: [] }, null, 2)}\n`);
    else process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(1);
  }

  if (manifestRecord.data?.schema_version !== 2) {
    if (manifestRecord.data?.schema_version !== 1) {
      const report = { valid: false, legacy: false, recognized: false, verdict: "INVALID", package_dir: packageDir, errors: [`不支持 schema_version=${JSON.stringify(manifestRecord.data?.schema_version)}；只接受 v2，或以 --allow-legacy 精确识别已 pin 的 v1。`], warnings: [], gates: [] };
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else outputText(report, options);
      process.exit(1);
    }
    let recognition;
    try {
      recognition = recognizeLegacyPackage(packageDir, projectContext.governance.legacyAllowlist);
    } catch (error) {
      recognition = { name: packageDir, recognized: false, treeDigest: null, expectedTreeDigest: null, error: error.message };
    }
    const allowed = options.allowLegacy && recognition.recognized;
    const legacyErrors = [];
    if (!options.allowLegacy) legacyErrors.push("schema v1 默认拒绝；--allow-legacy 也只识别精确 pin 的只读历史树。");
    if (!recognition.expectedTreeDigest) legacyErrors.push(`basename ${recognition.name} 未登记为历史 v1。`);
    else if (recognition.treeDigest !== recognition.expectedTreeDigest) legacyErrors.push("legacy tree digest 与只读 pin 不一致；历史包发生了增删、重命名或内容变化。");
    if (recognition.error) legacyErrors.push(recognition.error);
    const report = {
      valid: false,
      legacy: true,
      recognized: recognition.recognized,
      verdict: allowed ? "LEGACY_RECOGNIZED" : "LEGACY_REJECTED",
      package_dir: packageDir,
      package_basename: recognition.name,
      tree_digest: recognition.treeDigest,
      expected_tree_digest: recognition.expectedTreeDigest,
      errors: legacyErrors,
      warnings: allowed ? ["只读历史身份已识别；该结果不是结构有效、Gate eligible 或 Gate PASS。"] : [],
      gates: [],
    };
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else outputText(report, options);
    // Recognition is inventory metadata, not evaluator success. Keeping a nonzero exit
    // prevents callers that ignore JSON fields from turning a legacy skip into PASS.
    process.exit(1);
  }

  let approvalTrustRoot = { schema_version: 1, kind: "FeatureDeliveryApprovalTrust", keys: [] };
  try {
    if (!existsSync(options.trustRoot)) throw new Error(`approval trust root 不存在：${options.trustRoot}`);
    const trustMetadata = lstatSync(options.trustRoot);
    if (!trustMetadata.isFile() || trustMetadata.isSymbolicLink()) throw new Error(`approval trust root 必须是非符号链接普通文件：${options.trustRoot}`);
    if (trustMetadata.nlink !== 1) throw new Error(`approval trust root 不得是 hardlink：${options.trustRoot}`);
    approvalTrustRoot = parseYaml(options.trustRoot).data;
    for (const error of validateApprovalTrustRoot(approvalTrustRoot)) addUniqueError(errors, error);
  } catch (error) {
    addUniqueError(errors, error.message);
  }

  const coreFiles = ["feature.yaml", "evidence.yaml", "decisions.yaml"];
  for (const coreFile of coreFiles) {
    const fullPath = resolve(packageDir, coreFile);
    if (!existsSync(fullPath)) addUniqueError(errors, `缺少非空核心文件：${coreFile}`);
    else {
      const safePath = safeExistingFile(packageDir, fullPath, coreFile, errors);
      if (safePath && statSync(safePath).size === 0) addUniqueError(errors, `缺少非空核心文件：${coreFile}`);
    }
  }
  let evidenceRecord = { data: { entries: [] } };
  let decisionRecord = { data: { entries: [] } };
  try {
    const evidencePath = resolve(packageDir, "evidence.yaml");
    const decisionsPath = resolve(packageDir, "decisions.yaml");
    if (existsSync(evidencePath) && !lstatSync(evidencePath).isSymbolicLink()) evidenceRecord = parseYaml(evidencePath);
    if (existsSync(decisionsPath) && !lstatSync(decisionsPath).isSymbolicLink()) decisionRecord = parseYaml(decisionsPath);
  } catch (error) {
    addUniqueError(errors, error.message);
  }

  const policy = policyRecord.data;
  const policyDigest = policyRecord.digest;
  const manifest = manifestRecord.data;
  validatePolicy(policy, errors);
  enforceSchema(manifest, schema.$defs.featurePackage, schema, "feature.yaml", errors);
  enforceSchema(evidenceRecord.data ?? {}, schema.$defs.evidenceLedger, schema, "evidence.yaml", errors);
  enforceSchema(decisionRecord.data ?? {}, schema.$defs.decisionLedger, schema, "decisions.yaml", errors);
  validateManifest(manifest, packageDir, policy, policyDigest, repositoryRegistry, currentRepositoryRoot, projectContext.currentRepository, errors, warnings);
  validateManagedFileIdentities(manifest, packageDir, errors);
  const featureId = manifest.feature?.id ?? "UNKNOWN";
  const evidenceMap = validateEvidence(evidenceRecord.data ?? {}, featureId, policy, errors);
  validateEvidenceBindings(manifest, evidenceMap, errors);
  const decisions = validateDecisions(decisionRecord.data ?? {}, featureId, manifest, policy, evidenceMap, errors);

  for (const relativePath of ["feature.yaml", "evidence.yaml", "decisions.yaml"]) {
    const fullPath = resolve(packageDir, String(relativePath));
    if (!pathInside(packageDir, fullPath) || !existsSync(fullPath)) continue;
    const safePath = safeExistingFile(packageDir, fullPath, relativePath, errors);
    if (!safePath) continue;
    const tokenMatch = readFileSync(safePath, "utf8").match(/\{\{[A-Z0-9_]+\}\}/);
    if (tokenMatch) addUniqueError(errors, `${relativePath} 仍有未替换模板变量 ${tokenMatch[0]}。`);
  }

  const artifactDigests = computeArtifactDigests(packageDir, asArray(manifest.artifacts), errors);
  const digests = computeDigests(manifest, manifestRecord.source, artifactDigests, evidenceMap, decisions, policyDigest);
  validateRecordedPassedApprovals(decisions, manifest, evidenceMap, approvalTrustRoot, errors);
  const completionErrors = computeCompletionErrors(manifest, policy, packageDir);
  const effectiveStrict = options.strict || manifest.feature?.lifecycle === "completed";
  if (effectiveStrict) for (const reasons of Object.values(completionErrors)) for (const reason of reasons) addUniqueError(errors, reason);
  const evaluator = buildEvaluator(manifest, policy, evidenceMap, decisions, digests, approvalTrustRoot, errors, completionErrors);
  let gates = [];
  let defaultEnforcement = false;
  if (options.gate) gates = [evaluator.evaluate(options.gate, options.instance ?? "feature")];
  else if (effectiveStrict) {
    validateSummary(manifest, packageDir, evaluator, errors);
    gates = evaluator.allApplicableResults();
  } else {
    const allResults = evaluator.allApplicableResults();
    gates = allResults.filter((result) => decisions.latest.get(`${result.gate}:${result.instance}`)?.state === "passed");
    if (gates.length > 0) defaultEnforcement = true;
    const lifecycleRule = policy.lifecycle_enforcement?.[manifest.feature?.lifecycle];
    if (lifecycleRule && lifecycleRule !== "terminal") {
      defaultEnforcement = true;
      if (!gates.some((result) => result.gate === lifecycleRule && result.instance === "feature")) gates.push(evaluator.evaluate(lifecycleRule, "feature"));
    }
  }

  const gateSuccess = gates.every((gate) => gate.state === "passed" || gate.state === "not_applicable");
  const valid = errors.length === 0;
  const report = {
    valid,
    legacy: false,
    verdict: !valid ? "INVALID" : options.gate || effectiveStrict ? (gateSuccess ? "PASSED" : "BLOCKED") : defaultEnforcement && !gateSuccess ? "BLOCKED" : "VALID",
    package_dir: packageDir,
    feature: { id: featureId, profile: manifest.feature?.profile, delivery_target: manifest.feature?.delivery_target, terminal_gate: evaluator.targetPolicy?.terminal_gate },
    digests,
    gates,
    errors,
    warnings,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else outputText(report, { ...options, strict: effectiveStrict });
  process.exit(valid && (!options.gate && !effectiveStrict && !defaultEnforcement || gateSuccess) ? 0 : 1);
}

if (isDirectInvocation()) main();
