#!/usr/bin/env node
/**
 * Deploy phase 1 (spec §7, §8.3): every check, with NO Cloudflare credential in
 * the environment -- tests, builds and linters run third-party code, and none of
 * it gets to see the deploy key.
 *
 *   npm run deploy:check --prefix worker            # add -- --with-python when src/ changed
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle, listFiles, pruneDryRunArtifacts } from "./check-deploy-bundle.mjs";
import { writeStamp } from "./build-stamp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ROOT = ROOT.replaceAll("\\", "/"); // Docker Desktop takes forward slashes
// --user 0:0: the image runs as uid 10001, which cannot pip-install pytest. This
// throwaway container's mounts are all read-only; never do this to the live collector.
// Four extra read-only mounts, each earning its place, because python is the
// FIRST gate here: a missing path aborts the whole check before it ever builds,
// leaving a stale web/dist for the release phase to upload. See build-stamp.mjs.
//
//   scripts/ + web/tests/  tests/test_seam_fixture.py reads both -- the committed
//                          fixture under web/tests/fixtures, and the generator
//                          under scripts/ that it re-runs to prove the fixture is
//                          still byte-identical. 9 tests.
//   web/src/               tests/test_probe_ranker.py reads web/src/rank.ts, the
//                          SHIPPED ranker, so probe-ranker.py cannot quietly drift
//                          from the rules it exists to argue with. That is the
//                          whole point of those tests, so the mount is not
//                          incidental: without it they fail on a missing path and
//                          take the release with them. 7 tests.
//
// Adding a test that reads a new tree means adding its mount HERE too, or the
// suite passes locally and aborts the gate.
const PYTHON_TESTS =
  `docker run --rm --user 0:0 -v "${HOST_ROOT}/src:/repo/src:ro" -v "${HOST_ROOT}/tests:/repo/tests:ro" ` +
  `-v "${HOST_ROOT}/scripts:/repo/scripts:ro" -v "${HOST_ROOT}/web/tests:/repo/web/tests:ro" ` +
  `-v "${HOST_ROOT}/web/src:/repo/web/src:ro" ` +
  `-v "${HOST_ROOT}/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 ` +
  'docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"';

function run(label, command, cwd = ROOT) {
  console.log(`\n=== ${label}: ${command}`);
  // Fixed command strings only; shell is needed to run npm.cmd/npx.cmd on Windows.
  const result = spawnSync(command, { cwd, shell: true, stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (result.status !== 0) {
    console.error(`\ndeploy check FAILED at: ${label}`);
    process.exit(1);
  }
}

if (process.env.CLOUDFLARE_API_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is set. Run the check phase in a shell without the deploy key.");
  process.exit(1);
}

if (process.argv.includes("--with-python")) run("python tests", PYTHON_TESTS);
run("web tests", "npm test --prefix web");
run("web typecheck", "npm run typecheck --prefix web");
run("web lint", "npm run lint --prefix web");
run("worker tests", "npm test --prefix worker");
run("worker typecheck", "npm run typecheck --prefix worker");
run("script tests", "node --test scripts/tests/*.test.mjs");
run("production build", "npm run build --prefix web");
run("worker bundle (dry run)", "npx --no-install wrangler deploy --dry-run --outdir .wrangler/dry", join(ROOT, "worker"));

const workerConfig = JSON.parse(readFileSync(join(ROOT, "worker", "wrangler.jsonc"), "utf8"));
const pruneProblems = pruneDryRunArtifacts(join(ROOT, "worker", ".wrangler", "dry"), workerConfig);
if (pruneProblems.length > 0) {
  console.error(`\ndeploy bundle check FAILED:\n  ${pruneProblems.join("\n  ")}`);
  process.exit(1);
}

const secretPath = join(ROOT, "docker", "secrets", "parkcast_upload_secret");
const secrets = existsSync(secretPath) ? [readFileSync(secretPath, "utf8").trim()] : [];
const problems = checkBundle({
  distDir: join(ROOT, "web", "dist"),
  workerDir: join(ROOT, "worker", ".wrangler", "dry"),
  secrets,
});
if (problems.length > 0) {
  console.error(`\ndeploy bundle check FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nbundle check passed: ${listFiles(join(ROOT, "web", "dist")).length} files`);

// Last, and only now: written after every gate above has passed, so a stamp
// exists exactly when this build's inputs -- and this web/dist -- got through
// all of them. `release.mjs` refuses to upload without one that still matches,
// so a check that aborts anywhere earlier can no longer leave a stale web/dist
// behind for the release phase to ship as though it were new. What the digest
// covers, and what it deliberately does not, is in scripts/build-stamp.mjs.
const stamp = writeStamp(ROOT);
console.log(`build stamped ${stamp.builtAt} (sources ${stamp.sources.slice(0, 12)})`);

console.log("\n=== npm audit (review the output; not a pass/fail gate)");
spawnSync("npm audit", { cwd: join(ROOT, "web"), shell: true, stdio: "inherit" });
spawnSync("npm audit", { cwd: join(ROOT, "worker"), shell: true, stdio: "inherit" });
console.log("\nCheck phase complete. Release from a fresh PowerShell: see docs/deploy.md.");
