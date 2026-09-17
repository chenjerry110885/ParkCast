/**
 * One car park, as a driver reads it: chance of a space, name, walk, price,
 * an observed count when we have one, and the arrival time it was ranked for.
 *
 * The card carries forward the same three arguments `LotRow` used to make,
 * because none of them stopped being true when the row became a card:
 *
 *   - P, walk and price are three separate `fact` tiles and are never folded
 *     into a single score -- `rank.ts` computes an expected cost to *order*
 *     the list, but the user is shown its inputs, because a ranking you
 *     cannot argue with is a ranking you cannot trust.
 *   - The lot's own name stays in Chinese under the English UI, deliberately:
 *     it is what the sign at the entrance says, and a driver reads that sign
 *     at the exact moment the app has stopped helping. See the header of
 *     `i18n.ts`.
 *   - The formatting rules that keep this card honest live in `../format`;
 *     this component only arranges what they return, it never re-derives a
 *     number they already decided how to say.
 *
 * The whole card is one tap target: the `<li>` itself carries `onClick`, so
 * a tap anywhere on the head or the facts selects the lot. That can't be a
 * `<button>` wrapping everything, though -- `ConfidencePill` is its own
 * `<button>` (it needs to be independently focusable and to open its own
 * popover), and a `<button>` inside a `<button>` is invalid HTML that
 * `validateDOMNesting` warns about and that assistive tech handles
 * inconsistently. So keyboard and screen-reader users get one real,
 * focusable control instead -- the lot's name -- and everything that isn't
 * that name or the tags row is plain content the `<li>`'s own click handler
 * catches. The tags row stops its own clicks from reaching the `<li>`, so
 * tapping the confidence pill opens its popover without also selecting the
 * card out from under it.
 */
import { confidenceFor } from "../confidence";
import { formatClock } from "../arrival";
import { formatDistance, formatPrice, notUpdatingHours } from "../format";
import { Clock, Price, Spaces, Walk } from "../icons";
import { districtName, fillTemplate, lotTypeName, t, type Lang } from "../i18n";
import type { Ranked } from "../rank";
import { ConfidencePill } from "./ConfidencePill";
import { ProbabilityRing } from "./ProbabilityRing";

export interface LotCardProps {
  row: Ranked;
  lang: Lang;
  /** `grid.baseDataTs`: the reading a lot's time without an update is measured to. */
  baseDataTs: number;
  /** Minutes since `baseDataTs`, for the observed-count tile's age. */
  ageMin: number;
  /** The clock time this card was ranked for. */
  arrivalTs: number;
  /** Minutes from the reading to `arrivalTs`, for the confidence pill. */
  horizonFromReadingMin: number;
  /**
   * Observations behind this lot's half-hour-of-week cell in `week.bin`
   * (`week.ts`'s `probabilityAt`), for the confidence pill.
   *
   * `0` is a real answer and the honest default: it says "we have not watched
   * this lot at this hour often enough yet", which is exactly true before
   * `week.bin` has been fetched. It is never a stand-in for a number nobody
   * looked up -- a non-zero value here claims weeks of history for this
   * half-hour, and `lotCard.test.tsx` opens the popover to read that claim
   * back.
   */
  support: number;
  /** Whether this is the list's single top pick. */
  best: boolean;
  /** Whether this card is the one currently selected on the map. */
  selected: boolean;
  onSelect: (id: string) => void;
  /**
   * The pointer entered this card (its id) or left it (`null`), so the map can
   * halo the dot it belongs to. Desktop in practice: a tap fires `mouseenter`
   * too, which is harmless, and on the phone the sheet is over the map anyway.
   */
  onHover?: (id: string | null) => void;
  /** Position in the rendered list, capped for the entrance stagger. */
  index: number;
}

/** "NT$60 per hour" -> ["NT$60", "per hour"]; a wordy price (no digits) stays whole. */
function splitPrice(text: string): [string, string] {
  const at = text.indexOf(" ");
  if (at < 0 || !/\d/.test(text)) return [text, ""];
  return [text.slice(0, at), text.slice(at + 1)];
}

export function LotCard({
  row,
  lang,
  baseDataTs,
  ageMin,
  arrivalTs,
  horizonFromReadingMin,
  support,
  best,
  selected,
  onSelect,
  onHover,
  index,
}: LotCardProps) {
  const s = t(lang);
  const stalled = notUpdatingHours(row, baseDataTs);
  const unknownText = stalled === null ? s.noData : s.notUpdating;
  const confidence = confidenceFor({
    minutesFromReading: horizonFromReadingMin,
    readingAgeMin: ageMin,
    support,
    updating: row.lot.u === undefined,
    probability: row.probability,
  });
  const [priceValue, priceLabel] = splitPrice(formatPrice(row, s));
  const f = row.lot.f;
  const spaces =
    typeof f === "number"
      ? fillTemplate(row.lot.c === null ? s.spacesNowNoCapacityTemplate : s.spacesNowTemplate, {
          f,
          c: row.lot.c ?? "",
          n: ageMin,
        })
      : null;
  const className = [
    "lot-card",
    best ? "lot-card--best" : "",
    selected ? "lot-card--selected" : "",
    "anim-rise",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li
      className={className}
      style={{ ["--i" as string]: index }}
      data-testid="lot-row"
      data-lot-id={row.id}
      onClick={() => onSelect(row.id)}
      onMouseEnter={() => onHover?.(row.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="lot-card__head">
        <ProbabilityRing probability={row.probability} unknownText={unknownText} label={s.spaceLabel} best={best} />
        <div className="lot-card__ident">
          {/* The heading wraps the button, not the other way round: a heading
              inside a button is invalid markup, and assistive tech that honours
              it at all reports the level inconsistently. This way the name is
              still the card's heading *and* still one focusable control. */}
          <h3 className="lot-card__name" data-testid="lot-name" lang="zh-Hant">
            <button
              type="button"
              className="lot-card__button"
              aria-pressed={selected}
              aria-label={`${row.lot.n} — ${s.selectCard}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(row.id);
              }}
            >
              {row.lot.n}
            </button>
          </h3>
          <p className="lot-card__sub">
            {districtName(row.lot.a, lang)} · {lotTypeName(row.lot.t, lang)}
            {stalled !== null && <> · {fillTemplate(s.unchangedForTemplate, { n: stalled })}</>}
          </p>
          {(best || confidence !== null) && (
            <div className="lot-card__tags" onClick={(e) => e.stopPropagation()}>
              {best && (
                <span className="pill pill--best anim-shine">
                  <span aria-hidden="true">★ </span>
                  {s.bestPick}
                </span>
              )}
              {confidence !== null && <ConfidencePill level={confidence.level} reason={confidence.reason} lang={lang} />}
            </div>
          )}
        </div>
      </div>
      <div className="facts">
        <div className="fact" data-testid="lot-walk">
          <Walk className="fact__icon" />
          <span>
            <b className="fact__value">
              {row.walkMin} {s.minutesUnit}
            </b>
            <span className="fact__label">
              {s.walkTile} · {formatDistance(row.meters, s)}
            </span>
          </span>
        </div>
        <div className="fact" data-testid="lot-price">
          <Price className="fact__icon" />
          <span>
            <b className="fact__value">{priceValue}</b>
            <span className="fact__label">{priceLabel}</span>
          </span>
        </div>
        {spaces !== null && (
          <div className="fact" data-testid="lot-spaces">
            <Spaces className="fact__icon" />
            <span>
              <b className="fact__value">{spaces}</b>
              <span className="fact__label">{s.spacesNowLabel}</span>
            </span>
          </div>
        )}
        <div className="fact" data-testid="lot-arrival">
          <Clock className="fact__icon fact__icon--info" />
          <span>
            <b className="fact__value">{formatClock(arrivalTs)}</b>
            <span className="fact__label">{s.arrivalTile}</span>
          </span>
        </div>
      </div>
    </li>
  );
}
