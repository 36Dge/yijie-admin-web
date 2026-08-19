import { createHash, createPublicKey, verify } from "node:crypto";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const GATES = new Set(["G0", "G1", "G2", "G2C", "G3", "G4", "G5", "G6"]);

export function stableApprovalValue(value) {
  if (Array.isArray(value)) return value.map(stableApprovalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableApprovalValue(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function approvalPayload(manifest, decision) {
  const unsignedDecision = structuredClone(decision);
  delete unsignedDecision.attestation;
  return {
    schema_version: 1,
    kind: "FeatureDeliveryGateApproval",
    feature_id: manifest.feature?.id ?? null,
    // The Decision carries the immutable policy bytes digest it was reviewed
    // against.  Do not reconstruct historical signatures from the manifest's
    // current policy version: superseded approvals must remain auditable while
    // current Gate evaluation separately requires this digest to match now.
    policy_digest: decision.subject?.policy_digest ?? null,
    decision: unsignedDecision,
  };
}

export function canonicalApprovalPayload(manifest, decision) {
  return `${JSON.stringify(stableApprovalValue(approvalPayload(manifest, decision)))}\n`;
}

export function approvalPayloadDigest(manifest, decision) {
  return sha256(canonicalApprovalPayload(manifest, decision));
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")
    && new Set(value).size === value.length;
}

function parseTime(value) {
  return typeof value === "string" && ISO_TIME_RE.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

export function validateApprovalTrustRoot(trustRoot) {
  const errors = [];
  if (!trustRoot || typeof trustRoot !== "object" || Array.isArray(trustRoot)) return ["approval trust root 必须是 object"];
  const allowedRoot = new Set(["schema_version", "kind", "keys"]);
  for (const key of Object.keys(trustRoot)) if (!allowedRoot.has(key)) errors.push(`approval trust root 不允许字段 ${key}`);
  if (trustRoot.schema_version !== 1) errors.push("approval trust root schema_version 必须为 1");
  if (trustRoot.kind !== "FeatureDeliveryApprovalTrust") errors.push("approval trust root kind 无效");
  if (!Array.isArray(trustRoot.keys)) return [...errors, "approval trust root keys 必须是数组"];
  const ids = new Set();
  const keyFingerprints = new Map();
  for (const [index, key] of trustRoot.keys.entries()) {
    const label = `approval trust root keys[${index}]`;
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      errors.push(`${label} 必须是 object`);
      continue;
    }
    const allowed = new Set(["id", "actor", "roles", "gates", "profiles", "targets", "public_key_pem", "status", "valid_from", "valid_until"]);
    for (const field of Object.keys(key)) if (!allowed.has(field)) errors.push(`${label} 不允许字段 ${field}`);
    if (typeof key.id !== "string" || key.id.trim() === "") errors.push(`${label}.id 必须是非空字符串`);
    else if (ids.has(key.id)) errors.push(`${label}.id 重复：${key.id}`);
    else ids.add(key.id);
    if (typeof key.actor !== "string" || key.actor.trim() === "") errors.push(`${label}.actor 必须是非空字符串`);
    if (!uniqueStrings(key.roles) || key.roles.length === 0) errors.push(`${label}.roles 必须是非空唯一字符串数组`);
    if (!uniqueStrings(key.gates) || key.gates.length === 0 || key.gates.some((gate) => !GATES.has(gate))) errors.push(`${label}.gates 含未知或重复 Gate`);
    if (!uniqueStrings(key.profiles) || key.profiles.length === 0 || key.profiles.some((profile) => !["lite", "standard", "controlled"].includes(profile))) errors.push(`${label}.profiles 无效`);
    if (!uniqueStrings(key.targets) || key.targets.length === 0 || key.targets.some((target) => !["local_engineering", "staging", "production"].includes(target))) errors.push(`${label}.targets 无效`);
    if (key.status !== "active" && key.status !== "revoked") errors.push(`${label}.status 必须为 active|revoked`);
    if (parseTime(key.valid_from) === null) errors.push(`${label}.valid_from 必须是 ISO 时间`);
    if (key.valid_until !== null && parseTime(key.valid_until) === null) errors.push(`${label}.valid_until 必须是 ISO 时间或 null`);
    if (parseTime(key.valid_from) !== null && key.valid_until !== null && parseTime(key.valid_until) !== null
      && parseTime(key.valid_until) <= parseTime(key.valid_from)) errors.push(`${label}.valid_until 必须晚于 valid_from`);
    if (typeof key.public_key_pem !== "string" || !key.public_key_pem.includes("BEGIN PUBLIC KEY")) errors.push(`${label}.public_key_pem 必须是 PEM public key`);
    else {
      try {
        const publicKey = createPublicKey(key.public_key_pem);
        if (publicKey.asymmetricKeyType !== "ed25519") errors.push(`${label}.public_key_pem 必须是 Ed25519 key`);
        const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
        const previous = keyFingerprints.get(fingerprint);
        if (previous) errors.push(`${label}.public_key_pem 与 ${previous} 重复；同一密钥不得伪装多个身份/scope`);
        else keyFingerprints.set(fingerprint, label);
      } catch (error) {
        errors.push(`${label}.public_key_pem 无法解析：${error.message}`);
      }
    }
  }
  return errors;
}

export function verifyApprovalAttestation({ manifest, decision, trustRoot, now = Date.now(), requireCurrentValidity = true }) {
  const reasons = [];
  const attestation = decision?.attestation;
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return { valid: false, reasons: ["passed decision 缺少可信 approval attestation"] };
  }
  const allowedFields = new Set(["scheme", "key_id", "payload_digest", "signature"]);
  for (const field of Object.keys(attestation)) if (!allowedFields.has(field)) reasons.push(`approval attestation 不允许字段 ${field}`);
  if (attestation.scheme !== "ed25519-v1") reasons.push("approval attestation scheme 必须为 ed25519-v1");
  const key = trustRoot?.keys?.find((candidate) => candidate.id === attestation.key_id);
  if (!key) reasons.push(`approval key ${attestation.key_id ?? "UNKNOWN"} 不在外部信任根`);
  const payload = canonicalApprovalPayload(manifest, decision);
  const digest = sha256(payload);
  if (!DIGEST_RE.test(String(attestation.payload_digest ?? "")) || attestation.payload_digest !== digest) reasons.push("approval attestation payload_digest 与当前 decision 不一致");
  const signature = String(attestation.signature ?? "");
  if (!BASE64_RE.test(signature) || signature.length === 0) reasons.push("approval attestation signature 不是规范 base64");
  if (key) {
    if (key.status !== "active") reasons.push(`approval key ${key.id} 已撤销`);
    if (key.actor !== decision.actor?.id) reasons.push(`approval key ${key.id} 不属于 actor ${decision.actor?.id ?? "UNKNOWN"}`);
    for (const role of decision.roles ?? []) if (!key.roles?.includes(role)) reasons.push(`approval key ${key.id} 未授权角色 ${role}`);
    if (!key.gates?.includes(decision.gate)) reasons.push(`approval key ${key.id} 未授权 Gate ${decision.gate}`);
    if (!key.profiles?.includes(manifest.feature?.profile)) reasons.push(`approval key ${key.id} 未授权 Profile ${manifest.feature?.profile}`);
    if (!key.targets?.includes(manifest.feature?.delivery_target)) reasons.push(`approval key ${key.id} 未授权 Target ${manifest.feature?.delivery_target}`);
    const decidedAt = parseTime(decision.decided_at);
    const validFrom = parseTime(key.valid_from);
    const validUntil = key.valid_until === null ? null : parseTime(key.valid_until);
    if (validFrom !== null && decidedAt !== null && decidedAt < validFrom) reasons.push(`approval key ${key.id} 在决策时尚未生效`);
    if (validUntil !== null && decidedAt !== null && decidedAt >= validUntil) reasons.push(`approval key ${key.id} 在决策时已过期`);
    if (requireCurrentValidity && validUntil !== null && now >= validUntil) reasons.push(`approval key ${key.id} 当前已过期`);
    if (reasons.length === 0) {
      try {
        const verified = verify(null, Buffer.from(payload, "utf8"), createPublicKey(key.public_key_pem), Buffer.from(signature, "base64"));
        if (!verified) reasons.push("approval attestation 签名验证失败");
      } catch (error) {
        reasons.push(`approval attestation 无法验证：${error.message}`);
      }
    }
  }
  return { valid: reasons.length === 0, reasons, payload_digest: digest, key_id: key?.id ?? null };
}
