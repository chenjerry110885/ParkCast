/**
 * The chance-of-a-space ring: a coloured arc plus the percentage it stands
 * for, shared by the card and the map popup.
 *
 * The honesty rule this carries is the same one `colour.ts` and `LotRow`
 * already enforce, drawn again here because a ring is a third place someone
 * could quietly slip a `0` in for "no forecast": **`null` is not a value on
 * the scale.** A lot with no grid entry gets `unknownText` in an empty grey
 * ring (`ring--unknown`, arc omitted entirely) and never a `0%` that would
 * read as "definitely full" when the truth is "we don't know".
 *
 * A change in `probability` -- a fresher reading landed, or the scrubber
 * moved to a new horizon -- tweens the arc and counts the displayed number
 * through `motion.tween` rather than snapping, so the ring reads as *moving
 * to* its new answer instead of being silently replaced by it. Reduced
 * motion is handled inside `tween` itself; this component never checks the
 * media query.
 */
import { useEffect, useRef, useState } from "react";
import { formatProbability } from "../format";
import { colourFor } from "../map/colour";
import { DURATION, tween } from "../motion";

interface Props { probability: number | null; unknownText: string; label: string; best?: boolean; size?: number }

const STROKE = 6;

export function ProbabilityRing({ probability, unknownText, label, best = false, size = 64 }: Props) {
  const [shown, setShown] = useState(probability ?? 0);
  const previous = useRef(probability ?? 0);

  // Tween from the last value: a change of arrival time animates the arc and
  // counts the number. `previous` tracks what is actually on screen frame by
  // frame, not the target -- so a tween cancelled mid-flight by another
  // change (the scrubber dragged twice in quick succession) resumes from
  // wherever the arc visually stopped, rather than snapping back to the
  // interrupted target first.
  useEffect(() => {
    const target = probability ?? 0;
    const cancel = tween(previous.current, target, DURATION.slow, (v) => {
      setShown(v);
      previous.current = v;
    });
    return cancel;
  }, [probability]);

  const r = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, shown)));
  const unknown = probability === null;
  const className = ["ring", unknown ? "ring--unknown" : "", best ? "ring--glow" : ""].filter(Boolean).join(" ");
  return (
    <div className={className} style={{ width: size, height: size, ["--ring-colour" as string]: colourFor(probability) }}>
      <svg className="ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} />
        {!unknown && (
          <circle className="ring__arc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={circumference} strokeDashoffset={dashOffset} />
        )}
      </svg>
      {/* Through `formatProbability`, never a template here: the "null is not
          0%" rule has one owner, and `shown` is 0 while a tween runs on a lot
          that has no forecast at all. */}
      <span className="ring__value" data-testid="lot-probability">{formatProbability(unknown ? null : shown, { noData: unknownText })}</span>
      {!unknown && <span className="ring__label">{label}</span>}
    </div>
  );
}
