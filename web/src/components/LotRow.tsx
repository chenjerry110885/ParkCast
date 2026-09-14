/**
 * One car park, as a driver reads it: name, chance of a space, walk, price.
 *
 * The three numbers are three separate visible elements and are never folded
 * into a single score -- `rank.ts` computes an expected cost to *order* the
 * list, but the user is shown its inputs, because a ranking you cannot argue
 * with is a ranking you cannot trust.
 *
 * The lot's own name stays in Chinese under the English UI, deliberately: it is
 * what the sign at the entrance says, and a driver reads that sign at the exact
 * moment the app has stopped helping. See the header of `i18n.ts`.
 *
 * The formatting rules that keep this row honest live in `../format`.
 */
import { formatDistance, formatPrice, formatProbability, notUpdatingHours } from "../format";
import { districtName, fillTemplate, lotTypeName, t, type Lang } from "../i18n";
import type { Ranked } from "../rank";

interface LotRowProps {
  row: Ranked;
  lang: Lang;
  /** `grid.baseDataTs`: the reading a lot's time without an update is measured to. */
  baseDataTs: number;
}

export function LotRow({ row, lang, baseDataTs }: LotRowProps) {
  const s = t(lang);
  // A lot whose feed is not updating says so in the probability's place, set
  // like "no data" -- small and grey -- because it is the same absence of a
  // forecast, with its reason attached.
  const stalledHours = notUpdatingHours(row, baseDataTs);
  return (
    <li className="lot" data-testid="lot-row" data-lot-id={row.id}>
      <div className="lot-head">
        <div className="lot-ident">
          <h3 className="lot-name" data-testid="lot-name" lang="zh-Hant">
            {row.lot.n}
          </h3>
          <p className="lot-where">
            {districtName(row.lot.a, lang)} · {lotTypeName(row.lot.t, lang)}
          </p>
        </div>
        <p className="lot-chance" data-testid="lot-probability">
          <span
            className={
              row.probability === null ? "lot-chance-value is-unknown" : "lot-chance-value"
            }
          >
            {stalledHours === null ? formatProbability(row.probability, s) : s.notUpdating}
          </span>
          <span className="lot-chance-label">
            {stalledHours === null
              ? s.chanceOfSpace
              : fillTemplate(s.unchangedForTemplate, { n: stalledHours })}
          </span>
        </p>
      </div>
      <p className="lot-facts">
        <span data-testid="lot-walk">
          {s.walk} {row.walkMin} {s.minutesUnit} · {formatDistance(row.meters, s)}
        </span>
        <span data-testid="lot-price">{formatPrice(row, s)}</span>
      </p>
    </li>
  );
}
