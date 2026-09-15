#!/usr/bin/env node
/**
 * Refuse a commit whose staged changes contain the upload secret, or anything
 * shaped like one. GitHub push protection cannot recognise a random secret, so
 * this hook is the control (spec §6.1 T13).
 *
 * Enable once per clone:  git config core.hooksPath scripts/hooks
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_SHAPE = /pcu_[A-Za-z0-9_-]{43}/;

export function findSecrets(diff, knownSecret) {
  const problems = [];
  let file = "";
  for (const line of diff.split(/\r?\n/)) {
    // A "+++ " prefix normally marks a diff file header, but an added content
    // line whose text itself starts with "++ " renders identically (e.g. a
    // staged line "++ pcu_...", diffed, becomes "+++ pcu_..."). Treat the
    // prefix as a header for `file` tracking, but never skip the scan below --
    // every line starting with "+" (header-shaped or not) is still checked.
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
    }
    if (!line.startsWith("+")) continue;
    if (SECRET_SHAPE.test(line)) problems.push(`${file}: a line shaped like an upload secret`);
    if (knownSecret && line.includes(knownSecret)) problems.push(`${file}: the upload secret itself`);
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const diff = execFileSync(
    "git",
    ["diff", "--cached", "--no-color", "--no-ext-diff", "--text", "-U0"],
    { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const secretPath = join(root, "docker", "secrets", "parkcast_upload_secret");
  const known = existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  const problems = [...new Set(findSecrets(diff, known))];
  if (problems.length > 0) {
    console.error(`commit refused:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
