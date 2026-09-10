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

---

## L005 — A working prototype proves the mechanism, not the requirements

**Date:** 2026-09-07
**Trigger:** Plan 3d. Three plan-supplied claims that had been checked, and were still wrong.

**What happened:** Following L004, non-trivial logic was prototyped before being written into
the brief. The icon generator was run, its output rendered and looked at — a clean, recognisable
mark. It was handed over as verified. The implementer found that the *maskable* variant was not
maskable: it carried a 10% transparent border, which an Android launcher's circular crop renders
as chipped corners. The image was correct; it just did not meet the spec the manifest was about
to claim it met.

Two more in the same plan, both from the controller's own reasoning rather than from data:
"app shell: cache-first, because Vite hashes every filename" — true of every file except
`index.html`, the one file it does not hash, and therefore the one file cache-first would pin to
the first visit's bundle names forever. And "a new service worker takes over on the next full
load", which is simply false; measured in Edge 152, a same-tab reload left the old worker active
and the new one waiting.

**Why:** L004 says prototype before handing over, and that is right — but running something and
looking at the result only proves it *works*. It does not prove it satisfies a specification
nobody read. Every one of these three was an assertion about a standard (maskable icon safe
zones, Vite's asset hashing, the service worker lifecycle), and none of them was checked against
the standard.

**Rule:** When a brief makes a claim *about a specification* — a manifest requirement, a caching
guarantee, a lifecycle, a file format — cite where the claim comes from, or mark it explicitly as
unverified so the implementer knows to check it rather than transcribe it. "I ran it and it looked
right" is evidence about the mechanism only. And state the general rule with its exceptions
attached: "Vite hashes every asset filename" invites the reader to include the one it does not.

---

## L006 — Two experiments that share a handle are one experiment

**Date:** 2026-09-07
**Trigger:** Plan 3d's service-worker verification, twice, in two different agents.

**What happened:** An agent comparing the old and new service worker over CDP reused one
debugging port across both runs. The second run silently reattached to the *first* browser,
which still had the earlier worker installed — so both variants produced identical output and
the fix appeared to change nothing. Caught only because "no difference at all" was implausible.

In the same plan, an earlier agent measured "offline" with `Network.emulateNetworkConditions`
and got results that did not add up. The emulation does not apply to fetches made from *inside*
a service worker; genuine offline meant killing the server. They discarded two runs.

And `vite preview` answers a request for a missing file with `index.html` and a **200**, which
makes any "delete an asset and see what breaks" experiment lie in the most convincing direction.

**Why:** Each of these is a shared or lying handle between two supposedly independent
observations — a reused browser, an emulation layer that does not reach the code under test, a
server that fabricates success. None produced an error. All three produced a *plausible* wrong
answer, which is the expensive kind.

**Rule:** Before trusting a comparison, prove the two sides can actually differ. Use a fresh
port, profile and process per run; assert a control that is *expected to fail* and confirm it
does; and never verify a caching change against a server that cannot 404. If an experiment
reports "no difference", suspect the rig before believing the result.

### L006 amendment — `document.hidden` is a proxy, and it lies (2026-09-10)

Plans 3c and 3d both recorded that a hidden Browser pane "sets `document.hidden`, so
`requestAnimationFrame` never fires", and that taking a screenshot forces real frames. Both
halves are wrong, and following them wastes exactly the time they were written to save.

Measured while reviewing the app on 2026-09-10, with a blank map on screen:

```
hidden: false          visibility: "visible"
rafFiredWithin600ms: FALSE
webglContextLost: false     canvas 1084x604     MapLibre mounted
```

The page reported itself visible, a screenshot had already been taken, and frames still were not
being produced — the tool itself then said so plainly: *"The Browser pane is currently hidden. The
page is not rendered while it is not displayed."* Every DOM-level thing worked; only WebGL was
blank, because WebGL is the one thing that needs a frame.

**Rule:** probe the property you actually depend on, not a flag that usually correlates with it.
"Will this paint?" is answered by scheduling a `requestAnimationFrame` and seeing whether it fires,
never by reading `document.hidden`. And when a canvas is blank while the DOM around it is correct,
suspect the compositor before the code: check `rAF`, `isContextLost()` and the network panel — if
tiles are arriving as `206`s, the app is fine and the rig is not.
