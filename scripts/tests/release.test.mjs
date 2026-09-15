import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlaceholders, parsePreviewUrl, parseVersionId, previewAnswers, previewOrigin } from "../release.mjs";

test("finds every setup sentinel left in the Worker config", () => {
  const text = '{"id":"REPLACE_WITH_PROD_KV_ID","vars":{"PRODUCTION_HOST":"parkcast.REPLACE-SUBDOMAIN.workers.dev"}}';
  assert.deepEqual(findPlaceholders(text), ["REPLACE_WITH_PROD_KV_ID", "REPLACE-SUBDOMAIN"]);
});

test("accepts a filled-in config", () => {
  assert.deepEqual(findPlaceholders('{"id":"0123456789abcdef0123456789abcdef"}'), []);
});

test("reads the version id and preview URL from wrangler output", () => {
  const out = "Uploaded parkcast\nWorker Version ID: 1b2c3d4e-0000-4000-8000-123456789abc\nVersion Preview URL: https://1b2c3d4e-parkcast.example.workers.dev\n";
  assert.equal(parseVersionId(out), "1b2c3d4e-0000-4000-8000-123456789abc");
  assert.equal(parsePreviewUrl(out), "https://1b2c3d4e-parkcast.example.workers.dev");
  assert.equal(parseVersionId("nothing here"), null);
});

test("reads the preview URL only from its label, not from any workers.dev address", () => {
  const out = "Deployed parkcast triggers\n  https://parkcast.example.workers.dev\nWorker Version ID: 1b2c3d4e-0000-4000-8000-123456789abc\n";
  assert.equal(parsePreviewUrl(out), null);
});

test("builds a version's preview origin the way wrangler does", () => {
  assert.equal(previewOrigin("1b2c3d4e-0000-4000-8000-123456789abc", "parkcast.example.workers.dev"),
    "https://1b2c3d4e-parkcast.example.workers.dev");
});

test("treats only a 2xx from the preview origin as preview URLs still on", async () => {
  const answering = (status) => async () => ({ status });
  assert.equal((await previewAnswers("https://x.example", { fetchImpl: answering(200) })).open, true);
  assert.equal((await previewAnswers("https://x.example", { fetchImpl: answering(404) })).open, false);
  assert.equal((await previewAnswers("https://x.example", { fetchImpl: answering(302) })).open, false);
  const refusing = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await previewAnswers("https://x.example", { fetchImpl: refusing }), { open: false, detail: "did not answer (TypeError)" });
});
