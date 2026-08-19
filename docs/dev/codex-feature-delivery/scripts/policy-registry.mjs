#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMEWORK_DIR = resolve(SCRIPT_DIR, "..");
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
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
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${path}: 不是有效 date-time`);
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

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readProtectedFile(path, label, expectedRoot = null) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} 必须是非符号链接普通文件：${path}`);
  if (metadata.nlink !== 1) throw new Error(`${label} 不得是 hardlink：${path}`);
  const canonical = realpathSync(path);
  if (expectedRoot && !inside(expectedRoot, canonical)) throw new Error(`${label} realpath 越出策略注册表：${canonical}`);
  return readFileSync(canonical, "utf8");
}

function parsePolicy(source, label, schema) {
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${label} YAML 无效：${document.errors.map((error) => error.message).join("; ")}`);
  const policy = document.toJS();
  const errors = validateJsonSchema(policy, schema, schema, label, []);
  if (errors.length > 0) throw new Error(`Schema: ${errors.join("; ")}`);
  return policy;
}

export function gatePolicyDigest(source) {
  if (typeof source !== "string" && !Buffer.isBuffer(source)) throw new Error("Gate Policy source 必须是 string 或 Buffer。");
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function validateGatePolicySource(source, { label = "gate policy", frameworkDir = DEFAULT_FRAMEWORK_DIR } = {}) {
  if (typeof source !== "string") throw new Error(`${label} source 必须是 UTF-8 string。`);
  const root = realpathSync(resolve(frameworkDir));
  const schema = JSON.parse(readProtectedFile(resolve(root, "schemas/gate-policy.schema.json"), "Gate Policy Schema", root));
  return { data: parsePolicy(source, label, schema), digest: gatePolicyDigest(source), source };
}

function requireRegistryDirectory(path) {
  if (!existsSync(path)) throw new Error(`缺少策略归档目录：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`策略归档目录必须是非符号链接目录：${path}`);
  return realpathSync(path);
}

function loadSnapshot({ archiveRoot, digest, schema, expectedSource = null, label }) {
  const match = String(digest ?? "").match(DIGEST_RE);
  if (!match) throw new Error(`${label} digest 必须符合 sha256:<64 lowercase hex>。`);
  const path = resolve(archiveRoot, `${match[1]}.yaml`);
  const source = readProtectedFile(path, `${label} snapshot`, archiveRoot);
  const actualDigest = gatePolicyDigest(source);
  if (actualDigest !== digest) throw new Error(`${label} snapshot 内容 digest=${actualDigest}，与文件名/引用 ${digest} 不一致。`);
  if (expectedSource !== null && source !== expectedSource) throw new Error(`${label} snapshot 必须与 active gate-policy.yaml 原始 bytes 完全相同。`);
  return { path, source, data: parsePolicy(source, `${label} snapshot`, schema), digest: actualDigest };
}

export function loadActiveGatePolicy(frameworkDir = DEFAULT_FRAMEWORK_DIR) {
  const root = realpathSync(resolve(frameworkDir));
  const activePath = resolve(root, "gate-policy.yaml");
  const schemaPath = resolve(root, "schemas/gate-policy.schema.json");
  const archiveRoot = requireRegistryDirectory(resolve(root, "policies"));
  const schema = JSON.parse(readProtectedFile(schemaPath, "Gate Policy Schema", root));
  const source = readProtectedFile(activePath, "active gate-policy.yaml", root);
  const data = parsePolicy(source, "active gate-policy.yaml", schema);
  const digest = gatePolicyDigest(source);
  loadSnapshot({ archiveRoot, digest, schema, expectedSource: source, label: "active policy" });
  return { path: activePath, source, data, digest, archivedPath: resolve(archiveRoot, `${digest.slice(7)}.yaml`) };
}

export function resolveGatePolicy(policyRef, frameworkDir = DEFAULT_FRAMEWORK_DIR) {
  if (!isObject(policyRef)) throw new Error("Feature Package policy 必须是 object。");
  if (typeof policyRef.id !== "string" || policyRef.id.length === 0) throw new Error("Feature Package policy.id 必须是非空字符串。");
  if (typeof policyRef.version !== "string" || policyRef.version.length === 0) throw new Error("Feature Package policy.version 必须是非空字符串。");
  const digestMatch = String(policyRef.digest ?? "").match(DIGEST_RE);
  if (!digestMatch) throw new Error("Feature Package policy.digest 必须符合 sha256:<64 lowercase hex>。");

  const root = realpathSync(resolve(frameworkDir));
  const active = loadActiveGatePolicy(root);
  let selected = active;
  if (policyRef.digest !== active.digest) {
    const archiveRoot = requireRegistryDirectory(resolve(root, "policies"));
    const schema = JSON.parse(readProtectedFile(resolve(root, "schemas/gate-policy.schema.json"), "Gate Policy Schema", root));
    selected = loadSnapshot({ archiveRoot, digest: policyRef.digest, schema, label: "Feature Package policy.digest historical policy" });
  }
  if (selected.data.policy?.id !== policyRef.id || selected.data.policy?.version !== policyRef.version) {
    throw new Error(`Feature Package policy id/version 与 digest ${policyRef.digest} 对应的策略快照不一致。`);
  }
  return { ...selected, active: policyRef.digest === active.digest, activeDigest: active.digest };
}

const modulePath = fileURLToPath(import.meta.url);
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  if (process.argv.length !== 3 || process.argv[2] !== "active-metadata") {
    process.stderr.write("Usage: node policy-registry.mjs active-metadata\n");
    process.exit(2);
  }
  try {
    const active = loadActiveGatePolicy();
    process.stdout.write(`${active.data.policy.id}\t${active.data.policy.version}\t${active.digest}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(1);
  }
}
