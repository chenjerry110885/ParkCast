import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  DIST_PATHS,
  SOURCE_PATHS,
  digest,
  measure,
  readStamp,
  sourceFiles,
  staleness,
  writeStamp,
} from "../build-stamp.mjs";

let root;
const put = (rel, content) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

/** The smallest tree `measure` has an opinion about: some source, some build. */
const repo = () => {
  put("web/src/main.ts", "export const x = 1;\n");
  put("web/index.html", "<!doctype html>\n");
  put("web/package.json", '{"name":"web"}\n');
  put("worker/src/index.ts", "export default {};\n");
  put("worker/wrangler.jsonc", '{"name":"parkcast"}\n');
  put("web/dist/index.html", '<script src="/assets/index-AAAA.js"></script>\n');
  put("web/dist/assets/index-AAAA.js", "console.log(1);\n");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stamp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// --- what the digest is sensitive to ---------------------------------------

test("a changed byte changes the digest", () => {
  repo();
  const before = digest(root, SOURCE_PATHS);
  put("web/src/main.ts", "export const x = 2;\n");
  assert.notEqual(digest(root, SOURCE_PATHS), before);
});

test("renaming a file changes the digest even though no byte moved", () => {
  repo();
  const before = digest(root, SOURCE_PATHS);
  renameSync(join(root, "web/src/main.ts"), join(root, "web/src/entry.ts"));
  assert.notEqual(digest(root, SOURCE_PATHS), before,
    "hashing contents alone would call a rename no change at all");
});

test("a new file changes the digest", () => {
  repo();
  const before = digest(root, SOURCE_PATHS);
  put("web/src/extra.ts", "export const y = 1;\n");
  assert.notEqual(digest(root, SOURCE_PATHS), before);
});

test("the digest is stable across calls on an unchanged tree", () => {
  repo();
  assert.equal(digest(root, SOURCE_PATHS), digest(root, SOURCE_PATHS));
});

test("the digest does not depend on which paths were listed first", () => {
  repo();
  const forwards = digest(root, SOURCE_PATHS);
  const backwards = digest(root, [...SOURCE_PATHS].reverse());
  assert.equal(backwards, forwards, "the file list is sorted, so the order given must not matter");
});

test("web/dist is outside the source digest and web/src outside the dist digest", () => {
  repo();
  const sources = digest(root, SOURCE_PATHS);
  const dist = digest(root, DIST_PATHS);
  put("web/dist/assets/index-AAAA.js", "console.log(2);\n");
  assert.equal(digest(root, SOURCE_PATHS), sources, "a rebuild must not read as a source change");
  assert.notEqual(digest(root, DIST_PATHS), dist);
});

test("a path that does not exist contributes nothing rather than throwing", () => {
  repo();
  const listed = sourceFiles(root, [...SOURCE_PATHS, "web/nope", "web/nope.json"]);
  assert.deepEqual(listed, sourceFiles(root, SOURCE_PATHS));
});

test("sourceFiles walks into directories and returns repo-relative posix paths", () => {
  repo();
  assert.deepEqual(sourceFiles(root, ["web/dist"]),
    ["web/dist/assets/index-AAAA.js", "web/dist/index.html"]);
});

// --- the verdict -----------------------------------------------------------

test("no stamp at all is stale", () => {
  repo();
  const problems = staleness(readStamp(root), measure(root));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no build stamp/);
});

test("a stamp written over this tree is fresh", () => {
  repo();
  writeStamp(root);
  assert.deepEqual(staleness(readStamp(root), measure(root)), []);
});

test("editing a source after the check phase is stale", () => {
  repo();
  writeStamp(root);
  put("web/src/main.ts", "export const x = 99;\n");
  assert.deepEqual(staleness(readStamp(root), measure(root)),
    ["the sources have changed since the check phase built this bundle"]);
});

test("replacing web/dist after the check phase is stale", () => {
  repo();
  writeStamp(root);
  put("web/dist/assets/index-AAAA.js", "console.log('stale');\n");
  assert.deepEqual(staleness(readStamp(root), measure(root)),
    ["web/dist has changed since the check phase validated it"]);
});

test("the two-day-old release: an old stamp against a newer tree is stale", () => {
  repo();
  writeStamp(root);                       // the check phase that did finish
  put("web/src/main.ts", "export const preference = 1;\n");  // work committed since
  // The release phase is about to upload the SAME web/dist as before, which is
  // exactly the failure this exists to stop: `dry` and `dist` both still exist,
  // and every other gate in release.mjs passes.
  const problems = staleness(readStamp(root), measure(root));
  assert.ok(problems.length > 0, "a stale bundle must not be allowed to report a successful release");
});

test("a truncated stamp is no stamp, not a crash", () => {
  repo();
  writeStamp(root);
  put("worker/.wrangler/build-stamp.json", '{"sources": "abc"');
  assert.equal(readStamp(root), null);
});

test("a stamp missing its fields is no stamp", () => {
  repo();
  writeStamp(root);
  put("worker/.wrangler/build-stamp.json", '{"builtAt": "2026-09-21T00:00:00.000Z"}');
  assert.equal(readStamp(root), null);
});

test("writeStamp records when it ran", () => {
  repo();
  const stamp = writeStamp(root);
  assert.match(stamp.builtAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readStamp(root).builtAt, stamp.builtAt);
});
