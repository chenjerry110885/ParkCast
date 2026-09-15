/**
 * The confidence pill: how much of the ring's number is the live reading
 * versus the usual pattern for this time, named in one word and explained
 * in one tap.
 *
 * `confidence.ts` already refuses to guess -- `confidenceFor` returns `null`
 * rather than a level when there is nothing to grade -- so by the time a
 * level reaches here it is always one of `"high" | "medium" | "low"`; the
 * `null` case is the caller's to handle by not rendering a pill at all. What
 * this component owns is turning that level into words a driver can act on:
 * the button names the level, and its popover (closed until tapped, so nobody
 * reads it who has not asked for it) says in one sentence whether the number
 * next to it is mostly the live sensor or mostly climatology. The accessible
 * name always pairs the word "confidence" with the level word, so a screen
 * reader announces "Confidence, Medium" rather than a bare "Medium" that
 * could be mistaken for anything else on the card.
 */
import { useId, useState } from "react";
import type { Confidence } from "../confidence";
import { t, type Lang } from "../i18n";

export function ConfidencePill({ level, lang }: { level: Confidence; lang: Lang }) {
  const s = t(lang);
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const name = { high: s.confidenceHigh, medium: s.confidenceMedium, low: s.confidenceLow }[level];
  const why = { high: s.confidenceWhyHigh, medium: s.confidenceWhyMedium, low: s.confidenceWhyLow }[level];
  return (
    <>
      <button type="button" className={`pill pill--${level} pill--button`} aria-expanded={open} aria-controls={noteId} onClick={() => setOpen((o) => !o)}>
        {s.confidence} · {name}
      </button>
      {open && <p id={noteId} role="note" className="popover anim-pop">{why}</p>}
    </>
  );
}
