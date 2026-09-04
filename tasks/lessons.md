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
