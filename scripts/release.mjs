#!/usr/bin/env node
/**
 * Deploy phase 2 (spec §7, §8.3): upload a version, promote it, apply the
 * workers.dev and preview-URL settings, smoke-test the live site, and roll back
 * automatically if the smoke test fails.
 *
 * Run ONLY in a fresh PowerShell where the user entered the deploy key with
 * Read-Host -AsSecureString, after `npm run deploy:check` passed. It runs the
 * pinned wrangler in worker/node_modules and Node built-ins -- nothing else.
 *
 *   npm run deploy:release --prefix worker
 *   npm run deploy:preview --prefix worker     # upload a preview version; never promoted
 *
 * In wrangler 4.131.1 `workers_dev` and `preview_urls` are applied only by
 * `wrangler deploy` and `wrangler triggers deploy`: `versions upload` merely reads
 * whether previews are on, and `versions deploy` never touches either. So both
 * modes run `triggers deploy` explicitly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measure, readStamp, staleness } from "./build-stamp.mjs";
import { checkBundle, pruneDryRunArtifacts } from "./check-deploy-bundle.mjs";
import { smoke } from "./smoke-live.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "worker");
const PREVIEW_TIMEOUT_MS = 15_000;

export function findPlaceholders(text) {
  return [...new Set(text.match(/REPLACE[A-Z_-]*/g) ?? [])];
}

export function parseVersionId(output) {
  return output.match(/Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
}

export function parsePreviewUrl(output) {
  return output.match(/Version Preview URL:\s*(https:\/\/[A-Za-z0-9.-]+\.workers\.dev)/)?.[1] ?? null;
}

/** A version's preview origin, built the way wrangler builds it: `<first 8 hex of the id>-<worker>.<subdomain>`. */
export function previewOrigin(versionId, productionHost) {
  return `https://${versionId.slice(0, 8)}-${productionHost}`;
}

/**
 * Whether a preview origin still serves. Only a 2xx counts as open; any other
 * status, a network error or the timeout is what a disabled preview URL gives.
 * Never throws.
 */
export async function previewAnswers(origin, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${origin}/`, { redirect: "manual", signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) });
    return { open: res.status >= 200 && res.status < 300, detail: `answered ${res.status}` };
  } catch (err) {
    return { open: false, detail: `did not answer (${err.name})` };
  }
}

function fail(message) {
  console.error(`release STOPPED: ${message}`);
  process.exit(1);
}

function wrangler(args, config) {
  const command = `npx --no-install wrangler ${args} --config ${config}`;
  console.log(`\n=== ${command}`);
  const result = spawnSync(command, { cwd: WORKER, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const preview = process.argv.includes("--preview");
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (token.length < 16) fail("the deploy key is not set in this shell (docs/deploy.md)");

  const configText = readFileSync(join(WORKER, "wrangler.jsonc"), "utf8");
  const placeholders = findPlaceholders(configText);
  if (placeholders.length > 0) fail(`worker/wrangler.jsonc still has setup sentinels: ${placeholders.join(", ")}`);
  const config = JSON.parse(configText);
  if (!existsSync(join(WORKER, ".wrangler", "dry"))) fail("run the check phase first (npm run deploy:check --prefix worker)");

  // `dry` existing only says some check phase once finished. It says nothing
  // about WHICH tree, and a check that aborts at any gate leaves the previous
  // run's `dry` and `web/dist` in place -- which this script then uploaded and
  // reported as a success. Twice. The stamp is the answer to "is this bundle
  // the one that passed?", and a mismatch stops the release rather than
  // shipping bytes nobody checked.
  const stale = staleness(readStamp(ROOT), measure(ROOT));
  if (stale.length > 0) {
    fail(`${stale.join("; ")}. Nothing was uploaded and the live site is unchanged. ` +
      `Run \`npm run deploy:check --prefix worker\` from ${ROOT} (NOT from worker/ -- ` +
      "--prefix is relative to the cwd, so from inside worker/ npm looks for worker/worker/package.json " +
      "and exits before running anything), then release again.");
  }
  const pruneProblems = pruneDryRunArtifacts(join(WORKER, ".wrangler", "dry"), config);
  if (pruneProblems.length > 0) fail(pruneProblems.join("; "));

  // Scan again, now that the deploy key exists to be leaked.
  const secretPath = join(ROOT, "docker", "secrets", "parkcast_upload_secret");
  const secrets = [token, existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : ""].filter(Boolean);
  const problems = checkBundle({ distDir: join(ROOT, "web", "dist"), workerDir: join(WORKER, ".wrangler", "dry"), secrets });
  if (problems.length > 0) fail(`bundle check failed:\n  ${problems.join("\n  ")}`);

  let configPath = "wrangler.jsonc";
  if (preview) {
    mkdirSync(join(WORKER, ".wrangler"), { recursive: true });
    // wrangler resolves a config's relative paths against the config file's own
    // directory, not the cwd. .wrangler/preview.jsonc sits one level deeper than
    // wrangler.jsonc, so main and assets.directory need an extra "../" or wrangler
    // reports the entry point missing (confirmed with a --dry-run before this was
    // added). No other field in wrangler.jsonc is a relative path.
    const previewConfig = {
      ...config,
      preview_urls: true,
      main: `../${config.main}`,
      assets: { ...config.assets, directory: `../${config.assets.directory}` },
    };
    writeFileSync(join(WORKER, ".wrangler", "preview.jsonc"), JSON.stringify(previewConfig, null, 2));
    configPath = ".wrangler/preview.jsonc";
    // Switch preview URLs on before the upload, or the upload gets no preview URL.
    const triggers = wrangler("triggers deploy", configPath);
    if (!triggers.ok) fail("triggers deploy failed, so preview URLs may not be on; nothing was uploaded and the live version is unchanged");
  }

  const upload = wrangler("versions upload", configPath);
  if (!upload.ok) {
    fail(preview ? "versions upload failed; the live version is unchanged, but preview URLs stay on until the next normal release"
      : "versions upload failed; nothing changed on the live site");
  }
  const versionId = parseVersionId(upload.output);
  if (versionId === null) fail("could not read the version id from wrangler's output");

  if (preview) {
    console.log(`\npreview version ${versionId}: ${parsePreviewUrl(upload.output) ?? "see the wrangler output above"}`);
    console.log("It is not live. Preview URLs stay on until the next normal release, whose `wrangler triggers deploy` switches them off.");
    return;
  }

  const deploy = wrangler(`versions deploy ${versionId}@100% --yes`, configPath);
  if (!deploy.ok) fail("versions deploy failed; the previous version is still live");

  const origin = `https://${config.vars.PRODUCTION_HOST}`;
  const triggers = wrangler("triggers deploy", configPath);
  if (!triggers.ok) {
    fail(`triggers deploy failed. Version ${versionId} IS LIVE, but workers_dev and preview_urls: false were not applied and no smoke test ran. ` +
      `From worker/, rerun \`npx --no-install wrangler triggers deploy --config wrangler.jsonc\`, then \`node scripts/smoke-live.mjs ${origin}\` ` +
      "from the repository root; if either fails, run `npx --no-install wrangler rollback` from worker/.");
  }

  let result = { failures: ["not run"], warnings: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(20_000); // let the new version reach the edge before judging it
    try {
      result = await smoke(origin);
    } catch (err) {
      // smoke() is written to never throw; this is a last-resort guard so an
      // unexpected exception still lets the loop retry and, if it never
      // recovers, still trigger the rollback below instead of crashing with
      // the new version already live and unattended.
      result = { failures: [`smoke test threw: ${err.name}: ${err.message}`], warnings: [] };
    }
    if (result.failures.length === 0) break;
    console.warn(`smoke attempt ${attempt} failed:\n  ${result.failures.join("\n  ")}`);
  }
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (result.failures.length > 0) {
    const rollback = wrangler('rollback --yes --message "smoke test failed"', configPath);
    fail(rollback.ok
      ? "smoke test failed; rolled back to the deployment that was live before this release (on a first-ever release that is " +
        "the empty placeholder Worker `wrangler secret put` created during setup, which serves no site)"
      : "smoke test failed AND the rollback failed: run `npx --no-install wrangler rollback` from worker/ by hand now");
  }

  // The site is fine; this only proves preview_urls: false actually took effect.
  const previewCheck = previewOrigin(versionId, config.vars.PRODUCTION_HOST);
  const probe = await previewAnswers(previewCheck);
  if (probe.open) {
    fail(`version ${versionId} is live and passed the smoke test (do not roll back), but its preview URL ${previewCheck} ` +
      `${probe.detail}: preview URLs are still enabled. Turn them off in the Worker's settings on the dashboard.`);
  }
  console.log(`\npreview URL ${previewCheck} ${probe.detail}: preview URLs are off, as expected`);
  console.log(`deployed version ${versionId} to ${origin}; smoke test passed`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) await main();
