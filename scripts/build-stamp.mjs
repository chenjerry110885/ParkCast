#!/usr/bin/env node
/**
 * Proof that the bundle about to be uploaded is the one the check phase looked at.
 *
 * `release.mjs` used to ask only whether `worker/.wrangler/dry` existed. It does
 * exist after any check that ever completed, so a check that aborted early --
 * or one run days ago -- left a `web/dist` from an older commit that the release
 * phase uploaded and then called a success. That happened twice in one week, in
 * both cases printing a clean "deployed ... smoke test passed" over a bundle
 * from two days earlier, which is the worst shape a deploy failure can take:
 * nobody goes looking for a release that reported success.
 *
 * So the check phase records a digest of what it built FROM and what it built,
 * and the release phase refuses unless both still match. The stamp is written
 * last, after every gate has passed, so its presence means the whole check
 * passed over exactly these bytes -- not that a build was attempted.
 *
 * Bytes on disk, not git state: an uncommitted edit changes what vite compiles
 * just as surely as a commit does, and comparing against HEAD would wave it
 * through. Nothing here runs git at all.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the check phase leaves the stamp: beside `dry`, never inside it. */
export const STAMP_PATH = join("worker", ".wrangler", "build-stamp.json");

/**
 * Everything whose bytes decide what `npm run build --prefix web` and the
 * worker bundle come out as. `node_modules` is covered by the lockfiles rather
 * than walked: hashing it would cost more than the build.
 */
export const SOURCE_PATHS = [
  "web/src", "web/public", "web/index.html", "web/package.json",
  "web/package-lock.json", "web/vite.config.ts", "web/tsconfig.json",
  "web/tsconfig.app.json", "web/tsconfig.node.json",
  "worker/src", "worker/wrangler.jsonc", "worker/package.json",
  "worker/package-lock.json", "worker/tsconfig.json",
];

/** What the built site itself is, so a rebuild between the phases is caught too. */
export const DIST_PATHS = ["web/dist"];

/**
 * Every file under `paths`, as repo-relative posix paths, in a fixed order.
 * A path that does not exist contributes nothing rather than raising -- the
 * set above is deliberately a superset, so that adding a config file to the
 * repo does not need an edit here to be covered, and removing one does not
 * break the release.
 */
export function sourceFiles(root, paths) {
  const found = [];
  const visit = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) visit(`${rel}/${name}`);
    } else {
      found.push(rel);
    }
  };
  for (const p of paths) visit(p.replaceAll("\\", "/"));
  return found.sort();
}

/**
 * A digest over both the names and the contents of `paths`.
 *
 * The name goes in beside the bytes so that renaming a file changes the digest;
 * hashing contents alone would call a rename no change at all. The NUL after
 * each keeps `a/bc` + `d` from colliding with `a/b` + `cd`.
 */
export function digest(root, paths) {
  const hash = createHash("sha256");
  for (const rel of sourceFiles(root, paths)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** What the tree looks like right now, in the shape the stamp is stored in. */
export function measure(root) {
  return { sources: digest(root, SOURCE_PATHS), dist: digest(root, DIST_PATHS) };
}

export function writeStamp(root) {
  const value = { ...measure(root), builtAt: new Date().toISOString() };
  const path = join(root, STAMP_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/** The recorded stamp, or null if there is none or it is unreadable. */
export function readStamp(root) {
  const path = join(root, STAMP_PATH);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value?.sources === "string" && typeof value?.dist === "string" ? value : null;
  } catch {
    return null;    // a truncated or hand-edited stamp is no stamp
  }
}

/**
 * What is wrong with `recorded` as a description of `current`. Empty means the
 * build is the one the check phase passed, and the release may proceed.
 */
export function staleness(recorded, current) {
  if (recorded === null) {
    return ["there is no build stamp, so no check phase has passed over this tree"];
  }
  const problems = [];
  if (recorded.sources !== current.sources) {
    problems.push("the sources have changed since the check phase built this bundle");
  }
  if (recorded.dist !== current.dist) {
    problems.push("web/dist has changed since the check phase validated it");
  }
  return problems;
}
