# ParkCast — ranking preferences: cheaper, balanced, closer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The Stage A todo is archived at `docs/superpowers/plans/2026-09-17-stage-a-archive.md`.

**Goal:** Let a driver say whether they would rather walk less or pay less, without ever letting that preference make the app recommend a car park it believes is full.

**Architecture:** `rank.ts`'s `TIME_VALUE` splits into `WALK_VALUE` (the preset moves it) and `DELAY_VALUE` (floor-coupled: `max(5, WALK_VALUE)`). Three presets set the pair. The list's cap becomes distance-bounded with the tail behind an expander. `probe-ranker.py` gains a sweep that measures the safety invariant instead of asserting it.

**Tech Stack:** TypeScript/React, Python 3.13+ (stdlib only). No new dependency.

**Spec:** [`docs/superpowers/specs/2026-09-18-ranking-preferences-design.md`](../docs/superpowers/specs/2026-09-18-ranking-preferences-design.md) — **read §3 and §5 first**; they record two designs the measurement overturned.

## Global Constraints

- **The honesty rules bind every task.** A `null` probability never renders as a number; `0` is a real reading, never "not reporting"; the observed count `f` is never presented as a forecast; a lot whose feed has stopped still says so; **the ranker's expected-cost score is never shown** — this plan adds a control that changes that score and must still never display it.
- **The safety invariant, measured not asserted:** no preset may put an inversion at **#1**. "No inversions" is already false — the shipped ranker has 11, worst at #3 (88 on realistic destinations). The line is position, per `probe-ranker.py`'s own argument: a likely-full lot deep in a list is a trade-off the driver can see and reject; one at the top is the app recommending a car park it believes is full.
- **`DELAY_VALUE = max(5, WALK_VALUE)`.** Never below 5, so a preference cannot erode the penalty for being sent away. Pinning it outright makes Closer unsafe (35 inversions, worst #2); coupling it symmetrically makes Cheaper unsafe (19 from 0). Both were measured; do not "simplify" this rule.
- **Balanced must reproduce today's ordering exactly.** It is the shipped pair (5, 5). A driver who never opens the control sees no change. This is the regression that matters most.
- Both layouts first-class (phone bottom sheet < 768 px, desktop side panel ≥ 768 px); every tap target ≥ 44 px; `prefers-reduced-motion` honoured; nothing animates at rest.
- No new runtime dependency. Nothing leaves the device: the preference lives in `localStorage`, like the language toggle.
- **Never read or write anything under `data/`** — a live collector owns it, six cities deep. Use `web/.dev-artifacts/` (git-ignored) for artifact-driven work.
- **`git checkout --` is unsafe in this repo** (`core.autocrlf=true` rewrites LF→CRLF). Revert experiments with byte-exact backups verified by `cmp`.
- Tests: `cd web && npx vitest run` (**440** at the start of this plan) · `./.venv/Scripts/python.exe -m pytest -q` (**616**, but see below) · `cd worker && npm test` (**121**) · `node --test scripts/tests/*.test.mjs` (**55**).
- **Known flaky test, not yours:** `tests/test_artifacts_integration.py::test_end_to_end_over_real_observations` reads the **live** corpus and races the collector's writes — measured 2 failures in 4 consecutive runs on identical code. If it fails, re-run it; if it fails repeatedly *and* your change touches Python, investigate. Do not "fix" it by loosening its assertion.
- **Never commit** unless a task's final step says to. No AI attribution of any kind in any commit message (`CLAUDE.md:18`).

---

## File structure

| Path | Responsibility |
|---|---|
| `web/src/rank.ts` | `WALK_VALUE`/`DELAY_VALUE`, the `Preference` type, preset table, threading the pair through `rankLots` |
| `web/src/preference.ts` | reading and writing the stored preference, guarded like `places.ts` does storage |
| `web/src/components/PreferencePicker.tsx` | the three-option control |
| `web/src/App.tsx` | holding the preference, passing it to `rankLots`, the distance-bounded list |
| `web/src/i18n.ts` | the control's strings, both languages |
| `scripts/probe-ranker.py` | the split constants, and the preference sweep that measures the invariant |
| `CLAUDE.md`, `docs/state-of-play.md` | the split, the presets, the measured safety table |

---

### Task 1: split the constant

**Files:**
- Modify: `web/src/rank.ts`
- Test: `web/tests/rank.test.ts`

**Interfaces:**
- Produces: `export const WALK_VALUE = 5`, `export const DELAY_VALUE = 5`. `TIME_VALUE` is **deleted**, not aliased.

- [ ] **Step 1: Write the failing test.** Assert the walk term uses `WALK_VALUE` and the failure branch uses `DELAY_VALUE`, by giving them different values in a fixture and checking each side moves independently. A test that sets both to 5 proves nothing, because that is today's behaviour.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.** `certain = walkMin * WALK_VALUE + fee`; the circling penalty and the drive both take `DELAY_VALUE`. **Delete `TIME_VALUE`** rather than leaving an alias — `scripts/probe-ranker.py`'s `load_constants()` parses it by name out of the TypeScript, so its disappearance must break the probe loudly. That is the design working; Task 5 repairs it.
- [ ] **Step 4: Run the web suite.** Every existing ranker test must pass unchanged — with both constants at 5 the arithmetic is identical.
- [ ] **Step 5: Commit** — `git commit -m "refactor(rank): price the walk and the delay separately"`.

---

### Task 2: the preference and its presets

**Files:**
- Modify: `web/src/rank.ts`
- Create: `web/src/preference.ts`, `web/tests/preference.test.ts`
- Test: `web/tests/rank.test.ts`

**Interfaces:**
- Produces: `export type Preference = "cheaper" | "balanced" | "closer"`; `export const PREFERENCES: Record<Preference, { walk: number; delay: number }>`; `rankLots` takes `preference` in its input object, defaulting to `"balanced"`. `preference.ts` exports `readPreference(storage)` / `writePreference(storage, p)`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("prices the delay at the walk's value only when that is the higher of the two", () => {
  // DELAY_VALUE = max(5, WALK_VALUE). Never below 5, so a preference cannot make
  // being turned away cheap; above it when walking is dear, so making the walk
  // expensive does not relatively cheapen failure. Both halves were measured:
  // pinning breaks Closer, symmetric coupling breaks Cheaper. See the spec, section 5.
  expect(PREFERENCES.cheaper).toEqual({ walk: 2, delay: 5 });
  expect(PREFERENCES.balanced).toEqual({ walk: 5, delay: 5 });
  expect(PREFERENCES.closer).toEqual({ walk: 12, delay: 12 });
});

it("ranks identically to the shipped constants when balanced", () => {
  // The regression that matters most: a driver who never opens the control
  // must see no change whatsoever.
  expect(rankLots({ ...input, preference: "balanced" })).toEqual(rankLots(input));
});
```

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** `preference.ts` guards storage the way `places.ts` does — a private window, blocked site data or a thrown accessor must leave the app working on the default. An unrecognised stored value reads as `"balanced"`, never as a crash.
- [ ] **Step 4: Run the web suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(rank): three preferences, and the floor that keeps them safe"`.

---

### Task 3: the control

**Files:**
- Create: `web/src/components/PreferencePicker.tsx`, `web/tests/preferencePicker.test.tsx`
- Modify: `web/src/App.tsx`, `web/src/i18n.ts`, `web/src/styles/components.css`

- [ ] **Step 1: Write the failing tests.** Each option sets the preference and re-ranks; the choice survives a reload; every control is keyboard-reachable and labelled; the group has an accessible name; changing it does **not** scroll the list, re-centre the map or move the arrival. Assert the rendered order actually changes between `cheaper` and `closer` for a fixture where it should — a test that only checks the button's state would pass against a control wired to nothing.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** It sits with `ArrivalPicker`: both answer "what am I asking for", against the list's "here is what we found". **The score is never shown** — the control names a preference, and no card gains a NT$ figure. Copy is comparative ("cheaper", not "cheapest") because the ranker will still put a likely space above an unlikely bargain; read `i18n.ts` for register and keep the Chinese natural Taiwanese usage rather than a gloss.
- [ ] **Step 4: Run the web suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): choose whether to walk less or pay less"`.

---

### Task 4: the distance-bounded list

**Files:**
- Modify: `web/src/rank.ts` (`listRows`), `web/src/App.tsx`, `web/src/components/LotList.tsx`, `web/src/i18n.ts`
- Test: `web/tests/rank.test.ts`, `web/tests/lotList.test.tsx`

**Interfaces:**
- Produces: `export const NEARBY_RADIUS_M = 1500`; and `listRows` changes shape:

```ts
export interface ListRows { head: Ranked[]; nearby: Ranked[] }
export function listRows(ranked: readonly Ranked[], limit: number): ListRows
```

`head` is what the list draws today (the cap, plus the existing `UNKNOWN_RESERVE` rescue).
`nearby` is every remaining lot within `NEARBY_RADIUS_M`, in the ranker's order, disjoint from
`head`. **This is a breaking change to a returned type, and `App.tsx:842`'s `listed` is its only
caller** — move it in the same commit or the tree does not build.

- [ ] **Step 1: Write the failing tests.** Every lot within `NEARBY_RADIUS_M` is reachable; the tail keeps the ranker's order and is not re-sorted; the ranked head is unchanged with the expander closed; a lot already in the head never appears twice.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** **Measured, so size it honestly:** 1.5 km reaches a median of 64 Taipei lots and up to 157, which is why the tail sits behind a "show more nearby" expander rather than rendering with the head — 157 cards laid out at once is exactly the cost this project has already been told about once. Keep the existing `UNKNOWN_RESERVE` rescue working.
- [ ] **Step 4: Run the web suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): reach every car park worth walking to"`.

---

### Task 5: teach the probe the split, and measure the invariant

**Files:**
- Modify: `scripts/probe-ranker.py`
- Test: `scripts/tests/` if a harness fits there; otherwise the probe's own output is the artifact

- [ ] **Step 1: Repair `load_constants()`.** It parses `TIME_VALUE` by name and Task 1 deleted it, so the probe is broken right now — that is deliberate. Parse `WALK_VALUE` and `DELAY_VALUE` instead. **Keep parsing out of the TypeScript; never copy the numbers**, which is why the probe can be trusted at all.
- [ ] **Step 2: Add the preference sweep.** For each preset, over both samples — every lot's own position (adversarial: the risky lot sits at 0 m) and destinations drawn from the offline place index at least 50 m from any lot (realistic) — report inversion count, worst position, whether any reaches **#1**, and the LIST REACH columns.
- [ ] **Step 3: Check it against the measurement already taken.** The figures in the spec's §5 came from a harness that reused this probe's own `Ranker` and `count_inversions`. Your sweep should reproduce them: Cheaper 0 / Balanced 11 / Closer 8 on lot positions, and no preset at #1 in either sample. **If your numbers disagree, say so loudly rather than adjusting anything** — one of the two is wrong and it matters which.
- [ ] **Step 4: Run the probe and the Python suite.**
- [ ] **Step 5: Commit** — `git commit -m "feat(probe): measure the safety of every preference"`.

---

### Task 6: documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/state-of-play.md`, `README.md`

- [ ] **Step 1:** `CLAUDE.md` — the split constants and what each prices; the floor rule and why pinning and symmetric coupling were both rejected; that Balanced is the shipped pair. Correct the existing `TIME_VALUE` reference at `CLAUDE.md:208`. Record the spec's §9 boundary too, because it is the part most likely to be undone by accident: **the trained model must not learn preferences.** It predicts how likely a space is; the ranker decides what that probability is worth. That separation is what lets one `grid.bin` and one `week.bin` serve every driver — preferences inside the model would mean a model per combination, which the free tier cannot carry — and it keeps the Brier score a statement about calibration rather than about taste.
- [ ] **Step 2:** `docs/state-of-play.md` — a section with the **measured** safety table from your own probe run, not copied from the spec, and the list-density figures.
- [ ] **Step 3:** `README.md` — the app paragraph.
- [ ] **Step 4: Commit** — `git commit -m "docs: record the ranking preferences"`.

---

## Verification before the branch is finished

- Every suite green: web, Python, Worker, scripts. Re-run the known-flaky integration test rather than trusting one failure.
- The probe's sweep run and its output recorded — **no preset at #1 in either sample**.
- Balanced's ordering proven identical to the pre-branch ranker on a real roster, not only in a unit test.
- A browser pass at 375 px and desktop, light and dark: switch presets and confirm the list reorders, nothing scrolls or re-centres, the expander works, and no NT$ score appears anywhere.
- `npm run deploy:check --prefix worker` clean **from the repo root**. The release itself is the user's.
