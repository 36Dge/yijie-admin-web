import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TREE_DOMAIN = Buffer.from("codex-feature-delivery/legacy-tree/v1\0", "utf8");

function canonicalRelativePath(root, path) {
  return relative(root, path).split(sep).join("/").normalize("NFC");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function legacyTreeDigest(packageDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`legacy tree 不允许符号链接：${canonicalRelativePath(packageDir, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push({ path, relativePath: canonicalRelativePath(packageDir, path), size: stat.size });
      else throw new Error(`legacy tree 只允许普通文件和目录：${canonicalRelativePath(packageDir, path)}`);
    }
  };
  visit(packageDir);
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  const normalizedPaths = files.map((file) => file.relativePath);
  if (new Set(normalizedPaths).size !== normalizedPaths.length) throw new Error("legacy tree 含 Unicode 规范化后冲突的相对路径");

  const hash = createHash("sha256");
  hash.update(TREE_DOMAIN);
  for (const file of files) {
    const content = readFileSync(file.path);
    hash.update(Buffer.from(file.relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(content.byteLength), "ascii"));
    hash.update(Buffer.from([0]));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function loadLegacyPins(path) {
  const pins = new Map();
  for (const [index, rawLine] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 2) throw new Error(`${path}:${index + 1}: 必须是 <package-basename> <sha256:digest>`);
    const [name, digest] = fields;
    if (!/^FEAT-[0-9]+-[a-z0-9-]+$/.test(name)) throw new Error(`${path}:${index + 1}: 非法 package basename ${name}`);
    if (!DIGEST_RE.test(digest)) throw new Error(`${path}:${index + 1}: 非法 tree digest ${digest}`);
    if (pins.has(name)) throw new Error(`${path}:${index + 1}: 重复 package basename ${name}`);
    pins.set(name, digest);
  }
  return pins;
}

export function recognizeLegacyPackage(packageDir, pinPath) {
  const name = basename(packageDir);
  const pins = loadLegacyPins(pinPath);
  const expectedTreeDigest = pins.get(name) ?? null;
  let treeDigest = null;
  let error = null;
  try {
    treeDigest = legacyTreeDigest(packageDir);
  } catch (caught) {
    error = caught.message;
  }
  return {
    name,
    recognized: Boolean(expectedTreeDigest && treeDigest && expectedTreeDigest === treeDigest),
    treeDigest,
    expectedTreeDigest,
    error,
  };
}
