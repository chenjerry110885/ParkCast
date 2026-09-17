/**
 * The confidence pill: how much of the ring's number is the live reading
 * versus the usual pattern for this time, named in one word and explained
 * in one tap.
 *
 * `confidence.ts` already refuses to guess -- `confidenceFor` returns `null`
 * rather than a level when there is nothing to grade -- so by the time a
 * level reaches here it is always one of `"high" | "medium" | "low"`; the
 * `null` case is the caller's to handle by not rendering a pill at all. What
 * this component owns is turning that level, and the `reason` behind it,
 * into words a driver can act on: the button names the level, and its
 * popover (closed until tapped, so nobody reads it who has not asked for it)
 * names the *evidence* -- weeks of history, or a reading's own age -- rather
 * than just repeating the grade. That mirrors `confidence.ts`'s own point:
 * the label means "how much have we watched this lot at this hour", not
 * "how far away is this", and the popover has to say so in those terms or
 * the change is cosmetic. The accessible name always pairs the word
 * "confidence" with the level word, so a screen reader announces
 * "Confidence, Medium" rather than a bare "Medium" that could be mistaken
 * for anything else on the card.
 */
import { useId, useState } from "react";
import type { Confidence, ConfidenceReason } from "../confidence";
import { fillTemplate, t, type Lang } from "../i18n";

function reasonText(reason: ConfidenceReason, s: ReturnType<typeof t>): string {
  switch (reason.kind) {
    case "reading":
      return fillTemplate(s.confidenceReadingTemplate, { n: reason.ageMin });
    case "weeks":
      return fillTemplate(s.confidenceWeeksTemplate, { n: reason.weeks });
    case "thin":
      return s.confidenceThin;
  }
}

export function ConfidencePill({ level, reason, lang }: { level: Confidence; reason: ConfidenceReason; lang: Lang }) {
  const s = t(lang);
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const name = { high: s.confidenceHigh, medium: s.confidenceMedium, low: s.confidenceLow }[level];
  const why = reasonText(reason, s);
  return (
    <>
      <button type="button" className={`pill pill--${level} pill--button`} aria-expanded={open} aria-controls={noteId} onClick={() => setOpen((o) => !o)}>
        {s.confidence} · {name}
      </button>
      {open && <p id={noteId} role="note" className="popover anim-pop">{why}</p>}
    </>
  );
}
