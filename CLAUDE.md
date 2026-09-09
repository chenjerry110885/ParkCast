# ParkCast / 停車先知

Probabilistic parking availability forecasting for Taipei. Predicts **P(有位)** at the
user's *arrival time* instead of displaying stale current counts.

- **Design spec:** [`docs/superpowers/specs/2026-09-04-parkcast-design.md`](docs/superpowers/specs/2026-09-04-parkcast-design.md) — read this before implementing anything
- **Repo:** https://github.com/chenjerry110885/ParkCast (public)
- **Commit identity:** `Jerry Chen <chenjerry1108@gmail.com>` (set as **local** config; global stays as the work address)

---

## Git conventions — IMPORTANT

- **Conventional Commits**: `type(scope): subject` — `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`
- **Concise.** Subject line under ~72 chars. Body only when the *why* is non-obvious.
- **NEVER add `Co-Authored-By:` trailers.** No AI attribution of any kind in commit messages.
- Branch before committing if on `main` for anything non-trivial.
- Commit or push only when asked.

---

## Load-bearing project facts

Measured 2026-09-04 — do not re-derive, and do not assume these have drifted without re-measuring.

| Fact | Value |
|---|---|
| Availability feed | `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json` (472 KB, no auth) |
| Metadata feed | `https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json` (2.85 MB, no auth) |
| Update cadence | **exactly 5 min** |
| Publish lag | **+2:45 to +3:15, consistent** |
| Poll schedule | data_ts minutes are `≡3 (mod 5)`; publish is `≡1 (mod 5)` → **poll at minutes ≡1 (mod 5), second 30** (`:06:30, :11:30, …`) |
| Churn per tick | **42–47%** of lots change |
| Usable lots | **1,068** (valid count + known capacity), 12/12 districts |
| No-data sentinel | **`-9` → NULL, never 0** |
| Coordinates | `tw97x/y` = TWD97 TM2 (EPSG:3826); `EntranceCoord` = WGS84 lat/lon |

### Forecasting facts (measured 2026-09-05 over 62 real ticks / 72,858 observations)

| Fact | Value |
|---|---|
| `grid.bin` size | **25,821 bytes** at 1,075 lots × 24 horizons (**21-byte** header: `<4sBIIHBBI`, incl. `roster_id`) — re-measured 2026-09-07 |
| `lots.json` size | **183,325 bytes raw / ~30,110 gzipped** at 1,075 published lots (compact keys, parsed price, no fare text) — re-measured 2026-09-07 off the live files; gzip drifts a few bytes per tick with the timestamps |
| P(free≥1) base rate | **0.844 at 19:00**, rising to **0.919 at 23:00** Taipei |
| Lots in feed with history | **1,089** of 1,755 in metadata; **1,075 published** after dropping the 14 with no car spaces |

### A lot with no car spaces is not published (measured 2026-09-07)

The metadata roster grows *during* a day — 1,755 lots in the 2026-09-07 snapshot, 1,756 in the live
feed by 08:12 — and the daily snapshot is deliberately never rewritten, so a count taken from a
snapshot and one taken from the feed legitimately differ by a lot or two. Figures below are from
the snapshot.

`totalcar` is positive for **1,699** of the 1,755 lots and exactly **0** for **56**. There is no
`-9` in this field today — a measurement, not a guarantee. **`0` and `-9` are different facts**:
`0` means "not a car park" (a motorcycle or coach park), `-9`/missing means "not reported". 14 of
the zero-car lots had history and were being published; eight of them advertised a **98–100%**
chance of a car space at a park with no car bays (TPE1697 has 14 motorcycle bays and reports 25–31
free cars). `Lot.serves_cars` drops them **at publish time only**.

**The collection path is deliberately untouched.** A zero-car lot is still parsed, still collected
and still stored with `capacity_car = None`. Letting capacity `0` reach `validate` would clamp
`free_car` to 0 from that moment on and manufacture a discontinuity inside the corpus Plan 4 trains
on. Their junk history therefore still feeds the global climatology prior: they are **7,803
observations (1.22% of the corpus) at a 0.536 base rate**, holding the citywide prior at **0.8966**
where it would otherwise be **0.9010** — a **0.44 pp** depression. Deferred, not fixed: excluding
them from history would invalidate the per-Parquet counter cache.

**The target is saturated.** ~85-92% of lots have a space at any time, so a citywide Brier score is
dominated by easy cases and **climatology is a strong baseline**. Plan 4 must report skill on the
hard subset (lots at or near capacity) in addition to the citywide number, or the evaluation will
flatter itself.

**Price is unstructured, and measured (2026-09-06 over 1,756 lots).** `payex` is free Chinese text;
none are empty, 1,119 are distinct.

| | share | note |
|---|---|---|
| hourly rate present | **87%** | `NN元/時` |
| — time-tiered | 6% | `100元/時(09-21)、60元/時(21-09)` |
| — weekday-varying | 6% | `週一至週五…` |
| per-entry only (計次) | 3% | a different pricing model, not an hourly rate |
| neither → **unknown** | **10%** | |

**83 of the 104 time-tiered lots would be OVERSTATED by taking the first regex match**, so naive
parsing is not good enough. The ranker shows price as a visible column, so a wrong price is worse
than no price: **unknown must be a first-class value.** The UI shows it as unknown and the ranker
drops the price term for that lot — never substitutes zero, never substitutes an average, never
guesses.

### Ranker calibration — ratified and open parts

**Price outweighing walking distance is intended (ratified 2026-09-07).** Between two car parks
that both have a space, a driver takes the cheaper one. Measured across four real destinations,
the top ten results differ by at most 9 points of probability but by a factor of three in price,
so price and walking are the live variables. Do not "fix" this.

**`cost` is the expected cost of the whole trip in NT$, and means it literally** (changed
2026-09-09):

    cost = p x (walk + fare)  +  (1 - p) x (circling + cost of the best reliable alternative)

You do not pay this car park's fare for a space it did not have, and a failed attempt is charged
for the trip it forces rather than for circling alone. `RELIABLE_P` (0.9) defines which lots can
serve as that alternative; the fallback is one scalar per ranking, derived from the roster rather
than tuned, so failing in a dense district costs less than failing in a sparse one. At `p = 1` the
failure branch vanishes and the score is simply walk plus fare.

**What it replaced, and why.** The old score was `walk + fare + (1 - p) x circling`: it charged the
fare unconditionally and never charged the onward trip, so the entire probability range was worth
one circling penalty — NT$60, which is also 12 minutes of walking and **960 m on foot**. Being a
kilometre closer cancelled being certainly full.

`scripts/probe-ranker.py` measures this against the live artifacts and scores **both models on one
grid**, because the roster and the forecast move through the day and a before/after taken an hour
apart credits the calibration with whatever the clock did. Measured 2026-09-09 over every
destination whose own lot is under 50%:

| | inversions | worst position reached |
|---|---|---|
| legacy | 25 | **#1** |
| shipped | 19 | **#3** |

The count is not the point and should not be tuned to zero — a lot at 12% that is half the distance
for the same price is a defensible bet, and squeezing those out would mean over-weighting
probability to flatter a metric. **Position is the point.** The probe exits non-zero only when a
likely-full lot reaches *first place*, i.e. when the app's own top recommendation is a car park it
believes is full. Re-run it after any change to the ranker constants.

### The app is bilingual: English and 繁體中文

Required, and it shapes the artifact format rather than being a later polish pass. The upstream feed
is **100% Chinese for every user-facing field** — there is no English anywhere in it. So the
translatable boundary is fixed by the data:

| | distinct | translatable |
|---|---|---|
| UI chrome | — | yes, we author it |
| Districts (`area`) | **12** | yes, a small closed set |
| Lot types (`type2`) | **8** | yes |
| Lot names | **1,750** | **no — and they should not be** |

Lot names stay in Chinese under an English UI on purpose: they match the physical signage a driver
reads on arrival. Translating them would make the app harder to use, not easier. Traditional
characters throughout (zh-Hant / zh-TW), never Simplified.

### Collection runs locally, and the corpus has time-correlated gaps

The collector runs in Docker on the dev machine, not a cloud host. Decision taken 2026-09-05 under a
hard "no cost, no new attack surface" constraint: GCP's always-free tier requires a billing account
with a card and its budget alerts explicitly *do not* cap spending; Oracle's always-free tier
documents idle reclamation that this workload trips on every criterion.

**Consequence that must be disclosed, not hidden.** Whenever the machine sleeps, collection stops.
Measured 2026-09-09 with `scripts/corpus-coverage.py`, over the first six days:

| day | slots of 288 | |
|---|---|---|
| 2026-09-04 | 66 | 23% (started mid-day) |
| 2026-09-05 | 158 | 55% |
| 2026-09-06 | 287 | **100%** |
| 2026-09-07 | 128 | 44% |
| 2026-09-08 | **0** | nothing at all |
| **overall** | **640 / 1,728** | **37%** |

The gaps are **time-correlated, not random**, and the shape is the problem rather than the volume:
**12:00–14:30 was collected on one day in six** — the lunch-and-errands window, when parking is
most contested and the app is most wanted. Plan 4 must report per-bucket support alongside every
skill number; a citywide average will otherwise lean on the hours that happened to be collected.

`restart: unless-stopped` only fires when the container *exits*. A sleeping host does not exit it —
the process resumes mid-`sleep()` on wake, which is what happened on 2026-09-09 after a 44-hour
suspend. **Do not claim the restart policy covers this; it does not.** What did work is the
rollover ordering: `run_forever` archives completed days *before* pruning, so the 150,312 rows for
2026-09-07 sitting past the 48-hour window were compacted to Parquet at 08:06:43 on resume rather
than deleted.

**Planned, not yet done (decided 2026-09-09):** move the collector to a spare desktop that stays
powered on. **Runbook: [`docs/collector-move.md`](docs/collector-move.md)** — read it before
starting, because the two ways to lose the corpus (copying a live WAL, and running two collectors
at once) are both easy and both silent. Until the move happens the gaps above keep accruing, and
`data/` is the only thing in this project that cannot be rebuilt.

**Non-negotiable:** the collector runs from day one. Every day it is not running is a
training day that cannot be recovered.

---

# Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, stop and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

# Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

# Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

---

## Project-specific standards

- **Never interpolate missing observations.** Gaps stay explicit NULLs.
- **Never collapse `data_ts` and `observed_at`.** Doing so bakes the publish lag into every label.
- **Never split train/test at random.** Time-based splits only — lag features leak otherwise.
- **The model ships only if it beats *both* baselines** (persistence and climatology) on
  held-out data. A clean negative result is an acceptable, reportable outcome.
- Deterministic and testable over clever. The evaluation section of the spec is protected
  from scope cuts.

## Stack

- **Python 3.13** — collector, compaction, features, training (polars, LightGBM, pyarrow)
- **TypeScript + React + Vite + MapLibre GL + vitest** — PWA
- **SQLite** (hot, 48h) → **Parquet** (cold, daily) → **static artifacts** on CDN
- No database server. No REST API. Ranking and time-scrubbing run client-side.
