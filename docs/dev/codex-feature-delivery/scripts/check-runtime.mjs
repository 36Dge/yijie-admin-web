#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const directory = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(directory).sort()) {
  let command;
  let args;
  if (name.endsWith(".mjs")) { command = process.execPath; args = ["--check", resolve(directory, name)]; }
  else if (name.endsWith(".sh")) { command = "bash"; args = ["-n", resolve(directory, name)]; }
  else continue;
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}
process.stdout.write("Runtime syntax checks passed.\n");
