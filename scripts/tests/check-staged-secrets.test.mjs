import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecrets } from "../check-staged-secrets.mjs";

// Built at runtime so this file never contains a secret-shaped literal.
const SHAPED = "pcu" + "_" + "Z".repeat(43);
const diff = (added) =>
  `diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+${added}\n`;

test("refuses an added line shaped like an upload secret", () => {
  assert.equal(findSecrets(diff(`token = "${SHAPED}"`), "").length, 1);
});

test("refuses the known secret value wherever it appears", () => {
  assert.ok(findSecrets(diff("prefix-known-value-suffix"), "known-value").length >= 1);
});

test("ignores removed lines", () => {
  assert.deepEqual(findSecrets(`+++ b/x.txt\n-${SHAPED}\n`, ""), []);
});

test("allows code that only builds the shape", () => {
  assert.deepEqual(findSecrets(diff('SECRET = "pcu" + "_" + "A" * 43'), ""), []);
});

test("catches a secret-shaped content line that renders as a +++ header", () => {
  // Added content starting with "++ " renders in the diff as "+++ ...",
  // colliding with the file-header prefix. It must still be scanned.
  assert.ok(findSecrets(diff(`++ ${SHAPED}`), "").length >= 1);
});
