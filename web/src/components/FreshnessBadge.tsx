/**
 * The freshness badge: how old the reading behind this card's number is,
 * so a driver can weigh a chance-of-a-space number against how stale it
 * might be before trusting it.
 *
 * Teal and quiet under ten minutes, amber from ten on (`fresh--warn`), and
 * grey with the word once the feed has actually expired (`fresh--expired`,
 * carrying `expired` rather than just an old-looking number) -- three
 * distinct states because "12 minutes old" and "this lot's feed has died"
 * are different problems and must not share a colour. `ageMin={null}`
 * renders nothing: there is no reading to date, so there is nothing honest
 * to say about its age (compare `ProbabilityRing`'s `unknownText`, which
 * *does* render something for its own null case -- a badge has no slot to
 * put an unknown-age message in, so it simply steps aside).
 *
 * The badge also flashes once, briefly, whenever `ageMin` drops rather than
 * rises or holds -- the one unambiguous sign that a fresher reading just
 * landed, as opposed to time merely passing.
 */
import { useEffect, useRef, useState } from "react";
import { fillTemplate, t, type Lang } from "../i18n";

const WARN_FROM_MIN = 10;
const FLASH_MS = 700;

export function FreshnessBadge({ ageMin, expired, lang }: { ageMin: number | null; expired: boolean; lang: Lang }) {
  const s = t(lang);
  const [flash, setFlash] = useState(false);
  const last = useRef(ageMin);
  useEffect(() => {
    // Reacts to `ageMin` dropping over time (a fresher reading arriving) --
    // there is no render-time way to derive "this is lower than it used to
    // be" without keeping and comparing the previous value, which is what
    // this effect exists to do. Mirrors the precedent in useMapLibre.ts.
    const drop = ageMin !== null && last.current !== null && ageMin < last.current;
    last.current = ageMin;
    if (!drop) return undefined;
    // oxlint-disable-next-line react/set-state-in-effect
    setFlash(true);
    const id = setTimeout(() => setFlash(false), FLASH_MS);
    // Total, not just a cancel: if another `ageMin` arrives before the timer
    // fires, React tears this effect down first. Clearing the timer alone
    // would leave `flash` stuck true forever when that next update is not
    // itself a drop (nothing else would ever set it back to false), so the
    // cleanup also puts `flash` back down directly.
    return () => {
      clearTimeout(id);
      setFlash(false);
    };
  }, [ageMin]);
  if (ageMin === null) return null;
  const tone = expired ? "fresh--expired" : ageMin >= WARN_FROM_MIN ? "fresh--warn" : "";
  const text = fillTemplate(s.stalenessTemplate, { n: ageMin }) + (expired ? ` · ${s.expired}` : "");
  return (
    <span className={["fresh", tone, flash ? "fresh--flash" : ""].filter(Boolean).join(" ")} data-testid="staleness" aria-label={`${s.freshnessLabel}: ${text}`}>
      <i className="fresh__dot" aria-hidden="true" />
      {text}
    </span>
  );
}
