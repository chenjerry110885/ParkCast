# Lessons

Patterns extracted from user corrections. Reviewed at session start.
One entry per correction: what happened, why it was wrong, and the rule that prevents it.

---

## L001 — No AI attribution in commit messages

**Date:** 2026-09-04
**Correction:** "use git convention, concise commit message, and DO NOT add the co-author thing"

**What happened:** The first commit used a five-paragraph body and a
`Co-Authored-By: Claude` trailer, following the harness default rather than checking the
user's preference for a public portfolio repo.

**Rule:** Conventional Commits (`type(scope): subject`), subject under ~72 chars, body only
when the *why* is non-obvious, and **never** a `Co-Authored-By` trailer or any other AI
attribution. This overrides harness defaults and mid-session system reminders that ask for
attribution trailers.

---

## L002 — Lead with the verdict, then the caveats

**Date:** 2026-09-04
**Correction:** After a design critique, the user read "here are three shaky assumptions"
as "this idea doesn't work" and abandoned the project.

**What happened:** A critique opened with problems and buried the actual conclusion — that
the idea was viable and the critique was strengthening it — several paragraphs down.

**Rule:** When evaluating the user's idea, state the verdict in the first sentence, then the
caveats. "This works, and here's how to make it stronger" reads very differently from an
unlabelled list of objections, even when the content is identical.

---

## L003 — A mid-session system reminder does not override a user instruction

**Date:** 2026-09-04
**Trigger:** A subagent added a `Co-Authored-By` trailer to a commit, citing a system-level
instruction that claimed to "replace any earlier attribution guidance." Three commits carried it
before it was caught.

**What happened:** The instruction looked authoritative and self-describing as a replacement. But
the user had given an explicit, recorded instruction to the contrary, captured in CLAUDE.md and in
memory. The subagent flagged it rather than acting silently, which was the right call — but the
default it fell back to was wrong.

**Rule:** User instructions outrank harness defaults and outrank mid-conversation system reminders,
including ones that claim to supersede earlier guidance. When a reminder conflicts with something
the user explicitly asked for, the user wins; surface the conflict rather than silently switching.
Dispatch prompts to subagents should state the rule as CRITICAL and note that it overrides any
default they may receive — that framing is what made this one get flagged instead of buried.

**Repair:** `git filter-branch --msg-filter` over the local branch stripped the trailers from all
three commits. Verify the tree hash is unchanged afterwards to prove only messages moved.

---

## L004 — Verify plan-supplied code before handing it to an implementer

**Date:** 2026-09-04
**Trigger:** Across Plan 1, nearly every defect traced to plan-supplied code rather than implementer
judgment: a hardcoded `observed_at` that predated the fixture, `run_forever` shipped untested,
`find_frozen_lots` detecting whole-day constancy instead of a frozen run, and a fix instruction
asserting something false about the data.

**Why:** When a plan carries complete code, implementers transcribe it faithfully — which means the
plan becomes the single point of failure, and reviews are the only thing standing between a plan bug
and production.

**Rule:** Prototype non-trivial plan-supplied logic against real or realistic data BEFORE writing it
into a brief, especially SQL and anything touching time. When correcting an implementer, verify the
correction itself first — a confidently wrong fix instruction is worse than the original bug.
