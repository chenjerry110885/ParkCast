/**
 * One car park, as a driver reads it: chance of a space, name, walk, price,
 * an observed count when we have one, and what it says about 機車 and 充電.
 *
 * **The arrival time is deliberately not here.** It was a fact tile until the
 * owner's colleague pointed out that it is the one number on the card the
 * driver already chose: it is set in `ArrivalPicker` and read back above the
 * list, and a card cannot tell you anything you did not already know by
 * repeating it twenty times down the page. The tile slot it occupied now
 * carries the amenity tiles below, which say something new per car park.
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
import { reported, type Amenity } from "../amenities";
import { confidenceFor } from "../confidence";
import { formatDistance, formatPrice, notUpdatingHours } from "../format";
import { Charging, Price, Scooter, Spaces, Walk } from "../icons";
import { districtName, fillTemplate, lotTypeName, t, type Lang, type Strings } from "../i18n";
import type { Ranked } from "../rank";
import type { Lot } from "../types";
import { ConfidencePill } from "./ConfidencePill";
import { ProbabilityRing } from "./ProbabilityRing";

export interface LotCardProps {
  row: Ranked;
  lang: Lang;
  /** `grid.baseDataTs`: the reading a lot's time without an update is measured to. */
  baseDataTs: number;
  /** Minutes since `baseDataTs`, for the observed-count tile's age. */
  ageMin: number;
  /** Minutes from the reading to the chosen arrival, for the confidence pill. */
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
  /**
   * Whether `row.probability` was read out of `week.bin` rather than out of
   * `grid.bin` -- true for every arrival past the grid's own window.
   *
   * The card needs this for one reason: a grid number proves this lot was
   * moving at the reading, and a climatology number proves nothing of the
   * kind. See `notUpdatingHours`, which is where the distinction is spent.
   */
  fromHistory: boolean;
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

/**
 * One amenity fact tile -- 機車 or 充電 -- or `null` when the feed said nothing.
 *
 * Three states in, three renderings out, and the third one is the reason this
 * function exists rather than a `?? 0` at the call site:
 *
 *   - **a count** -- the number, exactly as it was published;
 *   - **a reported `0`** -- the tile still appears, and says `amenityNone` in
 *     words. The car park was asked and answered, and "no scooter bays" is
 *     something a scooter rider needs to be told;
 *   - **absent** -- `null`, so *no tile is drawn at all*. The card has no
 *     fixed number of tiles (the observed count already comes and goes with
 *     `f`), so there is no slot begging to be filled with a zero, and an
 *     omitted tile is the only rendering that claims nothing.
 *
 * Returning the element rather than a string keeps the "no tile" case a thing
 * the caller cannot accidentally render: there is no empty string to fall
 * through into a `<b>`.
 */
function AmenityTile({ lot, amenity, s }: { lot: Lot; amenity: Amenity; s: Strings }) {
  const value = reported(lot, amenity);
  if (!value.known) return null;
  const scooter = amenity === "scooter";
  const Glyph = scooter ? Scooter : Charging;
  return (
    <div className="fact" data-testid={scooter ? "lot-scooter" : "lot-charging"}>
      <Glyph className="fact__icon" />
      <span>
        <b className="fact__value">{value.count === 0 ? s.amenityNone : value.count}</b>
        <span className="fact__label">{scooter ? s.scooterTile : s.chargingTile}</span>
      </span>
    </div>
  );
}

export function LotCard({
  row,
  lang,
  baseDataTs,
  ageMin,
  horizonFromReadingMin,
  support,
  fromHistory,
  best,
  selected,
  onSelect,
  onHover,
  index,
}: LotCardProps) {
  const s = t(lang);
  const stalled = notUpdatingHours(row, baseDataTs, fromHistory);
  const unknownText = stalled === null ? s.noData : s.notUpdating;
  /**
   * What the card says about a feed that has stopped.
   *
   * With no probability the ring carries the words and the sub-line carries the
   * duration -- the ring has room for one or the other, and the words are the
   * claim. With a climatology probability the ring is showing a percentage, so
   * the words have to ride in the sub-line too or the card renders a number for
   * a car park that stopped reporting and never mentions it.
   *
   * It sits among the lot's own facts -- district, operator -- rather than
   * beside the ring, because that is what it is: a fact about this car park's
   * feed, not a hedge on the forecast. The figure above it is real, and the
   * banner over the list already says where it came from.
   */
  const stalledNote =
    stalled === null
      ? null
      : row.probability === null
        ? fillTemplate(s.unchangedForTemplate, { n: stalled })
        : `${s.notUpdating} · ${fillTemplate(s.unchangedForTemplate, { n: stalled })}`;
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
            {stalledNote !== null && (
              <>
                {" · "}
                <span data-testid="lot-stalled">{stalledNote}</span>
              </>
            )}
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
        {/* Only for the lots that actually reported them: a car park whose
            feed says nothing about scooters draws no scooter tile, rather
            than a tile reading "0" for a number nobody published. See
            `AmenityTile`. */}
        <AmenityTile lot={row.lot} amenity="scooter" s={s} />
        <AmenityTile lot={row.lot} amenity="charging" s={s} />
      </div>
    </li>
  );
}
