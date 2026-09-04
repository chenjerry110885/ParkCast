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
| Publish lag | **~3 min, consistent** → poll on phase offset `:03:20, :08:20, …` |
| Churn per tick | **42–47%** of lots change |
| Usable lots | **1,068** (valid count + known capacity), 12/12 districts |
| No-data sentinel | **`-9` → NULL, never 0** |
| Coordinates | `tw97x/y` = TWD97 TM2 (EPSG:3826); `EntranceCoord` = WGS84 lat/lon |

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
