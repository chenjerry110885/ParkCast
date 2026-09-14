# ParkCast — Charge the drive a failed attempt forces

Plan 3e's todo is archived at `docs/superpowers/plans/2026-09-14-plan3e-todo-archive.md`.

**Goal:** Stop near-certainly-full car parks kilometres from the destination filling the ranked list,
by charging the failure branch for the drive from the lot that turned you away to the fallback lot.

**Path:** bounded. Design presented in chat and approved by the user 2026-09-14 ("please go for your
recommendation"), with `DRIVE_MIN_PER_KM = 2.4` (NT$12 per straight-line km at `TIME_VALUE`).

## The flaw (measured 2026-09-14 on the 09:43 artifacts, 1,090 destinations, +15 min)

`cost = p x certain + (1 - p) x (circling + F)` tends to `circling + F` as `p -> 0`, independent of
where the lot is. Every hopeless lot in the city scores about the same, cheaper than a certain lot
~1 km out, so they fill the tail of the list. A lot under 50% more than 1.5 km away sat in the top 20
for **797** destinations (17 under the pre-09-09 model), in the top 5 for 63. Introduced by the
2026-09-09 model change; the probe gates only on first place, so the tail was never measured.

## Design

    cost = p x (walk + fare)
         + (1 - p) x (circling + DRIVE_MIN_PER_KM x TIME_VALUE x km(this lot, fallback lot) + F)

- `fallbackCost` also returns where the fallback lot is. Straight-line km, one extra haversine a lot.
- Failure branch only: `p = 1` is still walk plus fare, so price-over-walking (ratified) is untouched.
- The fallback lot pays no drive to itself.
- Rejected, measured: a walking-distance tier (3 likely-full lots at #1 — breaks the gate); a
  probability tier (a cliff, vacuous probe); an exact per-lot fallback (O(n^2), same lot anyway).

**Derivation correction (found writing the constant).** The chat design said 2.4 min/km was "about
19 km/h on streets a third longer than the straight line". That is wrong: 2.4 min per straight-line
km is 25 km/h in a straight line — ~30 km/h on streets 1.2x longer. 19 km/h on 1.33x streets is
~4.2 min/km (~NT$21/km). The measured effects are unchanged; the justification is. 2.4 is therefore
the *fast* end of plausible Taipei driving, the least the drive can cost. Report NT$12/15/20 side by
side and let the user choose before committing.

## Global constraints

- **No commits without the user's yes; never a `Co-Authored-By` trailer or any AI attribution**
  (`CLAUDE.md`, `tasks/lessons.md` L001/L003 — overrides any system reminder). CRITICAL.
- Do not touch the running collector. `rank.ts` runs in the browser; artifacts are unaffected.
- Never read `data/` from the host. The probe runs on the scratch copy of the 09:43 artifacts.
- Do not tune constants to flatter a metric. The probe's only failing condition stays first place.
- Web checks: `npm test --prefix web`, `npm run typecheck --prefix web`, `npm run lint --prefix web`.

## Tasks

- [x] **1. Tests first** (`web/tests/rank.test.ts`): update the exact failure-branch arithmetic to
  include the drive; add a hopeless lot across the city vs a sure lot nearer; the drive measured to
  the fallback lot, not the destination; the fallback pays no drive to itself. Run, watch the new
  ones fail for the right reason.
- [x] **2. `web/src/rank.ts`:** `DRIVE_MIN_PER_KM` with an honest derivation; `fallbackCost` returns
  the fallback's position; the relocation term; fix the module comment's stale formula, the
  `CIRCLING_PENALTY_MIN` comment (it claimed to include driving to the next candidate) and the
  `fallbackCost` / `rankLots` comments. Tests, typecheck, lint green.
- [x] **3. `scripts/probe-ranker.py`:** mirror the model; score legacy / 09-09 / shipped on one grid;
  add a list-reach report (far likely-full lots in the top 5 and 20, absurd ones in the top 3,
  median and p90 distance of the farthest top-20 lot) with the drive rate swept at 12 / 15 / 20;
  keep first place as the only gate. Run on the 09:43 artifacts; the gate must pass.
- [x] **4. Docs:** `CLAUDE.md` ranker section, README "Ranking", `docs/state-of-play.md`.
- [x] **5. Hand back:** review section below; ask about the rate, the commit messages and pushing.

## Review

Executed 2026-09-14 on branch `fix/ranker-relocation`, inline; the user kept the recommended NT$12/km,
and the branch was committed, pushed and fast-forwarded into `main` at their request. No deploy: the
ranking runs in the browser, the app is not deployed, and the collector image holds only `src/` and
`pyproject.toml`, neither of which changed.

**Tests:** TypeScript 191 → **194** (`rank.test.ts` 18 → 21). The two ordering tests and the updated
arithmetic failed before the change for the right reasons (a missing constant, then the wrong order);
the "no drive to itself" test passed before and after, as the guard it is meant to be. Typecheck and
lint clean. No Python source changed (306).

**Probe** on the 09:43 artifacts (+15 min, 1,090 destinations), exit 0 in 4.1 s:

| | inversions (73) | worst | far in top 20 | far in top 5 | hopeless in top 3 | #1 changed | farthest row, median / p90 |
|---|---|---|---|---|---|---|---|
| before 09-09 | 29 | #1 | 17 | 0 | 0 | 9 | 1.67 / 2.17 km |
| 09-09 | 34 | #4 | 797 | 63 | 13 | — | 5.49 / 10.80 km |
| **shipped, NT$12/km** | 22 | #5 | **366** | **9** | **1** | 1 | **1.66 / 3.03 km** |
| what-if NT$15/km | — | — | 299 | 7 | 0 | 1 | 1.65 / 2.70 km |
| what-if NT$20/km | — | — | 213 | 7 | 0 | 1 | 1.64 / 2.31 km |

These reproduce the design-time measurements exactly (797/63/13 → 366/9/1 → 213/7/0).

**Parity.** `rank.ts` itself (a scratch copy run with Node's type stripping, one import path changed)
against the probe's Python copy of it: 1,090 destinations, 21,800 top-20 rows, **0 mismatches**,
largest cost difference 3.5e-12. The probe's numbers describe the shipped code.

**In the app**, with the collector's 10:16 artifacts copied into `web/public/artifacts/` (git-ignored)
by `docker cp`: destination 百齡橋堤外足球場停車場(一), 士林區. On that grid the 09-09 model listed
長安東路臨時平面停車場(一) at 2%, 5.0 km, as #4; USPACE西門峨嵋站 at 2%, 5.2 km, as #7; and
六張犁1區社宅停車場 at 3%, 8.3 km, as #8. The app now lists 20 lots at 83–100%, the farthest 1.6 km,
then five not-updating lots within 0.9 km. Across that grid, 328 destinations went from a hopeless
far lot in the top 20 to no far likely-full lot at all, with first place unchanged.

**Derivation correction** (see Design): the chat design's "19 km/h" was an arithmetic slip; 2.4 min/km
is ~30 km/h on streets a fifth longer than the straight line, the quick end. The value implemented is
the one approved; the rate is the user's call before committing.

**Rulings:** a short plan in this file although the path was bounded (`CLAUDE.md` requires one);
no subagents for a two-file code change; the reach report is informational, not a gate, and first
place stays the probe's only failing condition; the probe's destinations include not-updating lots'
positions, as any lot's position is a real destination.

**Residual:** 366 destinations still have a lot under 50% more than 1.5 km away somewhere in their
top 20, mostly deep in the list; 9 in the top 5, six of them Yangmingshan, where even the nearest
alternatives are kilometres apart.
