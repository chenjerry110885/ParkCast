"""Compute the week-of-history climatology cells `artifacts.encode_week` packs.

`artifacts.py` is purely a serialisation layer -- it must not import
`forecast`, or the artifact format would depend on the forecasting model
instead of the other way round. This module is what sits between them: it
reads a `History`'s counts through `forecast.Climatology` (the same tier
chain -- bucket -> lot -> global -- the live forecast uses) and returns the
`(probability, support)` cells `encode_week` expects, one row per lot.

Rows here are keyed by whatever `lot_ids` holds, which for this module is the
`History`'s own namespaced store id (`taipei:TPE0001`) -- `encode_week` wants
the bare, published id instead, and converting between the two is Task 3's
job, not this module's.
"""
from collections.abc import Sequence

from parkcast import config, forecast


def _bucket_timestamp(bucket: int) -> int:
    """A Unix timestamp `ts` such that `forecast.week_bucket(ts) == bucket`.

    `week_bucket` computes `((ts + 8h) // 60 // CLIMATOLOGY_BUCKET_MIN) %
    WEEK_BUCKETS` -- it anchors on the bare Unix epoch and does no calendar
    arithmetic, so bucket 0 is Thursday 00:00 Taipei (1970-01-01 was a
    Thursday), not Monday. Reimplementing a Monday-anchored week here would
    silently disagree with it. Instead this inverts that exact arithmetic:
    setting `local_min = bucket * CLIMATOLOGY_BUCKET_MIN` lands the inner
    `// CLIMATOLOGY_BUCKET_MIN` back on `bucket` exactly, and `bucket` is
    always already in `range(WEEK_BUCKETS)` so the outer `% WEEK_BUCKETS` is a
    no-op; undoing the same +8h Taipei shift `week_bucket` applies recovers a
    real epoch timestamp. `test_week.py` asserts this round-trips for every
    bucket in the week against `week_bucket` itself, not against this
    derivation restated.
    """
    local_min = bucket * config.CLIMATOLOGY_BUCKET_MIN
    return local_min * 60 - 8 * 3600


def build_week_cells(
    history: forecast.History, lot_ids: Sequence[str]
) -> dict[str, list[tuple[float | None, int]]]:
    """One row per id in `lot_ids`: `config.WEEK_BUCKETS` `(probability,
    support)` cells in bucket order, ready for `artifacts.encode_week`.

    The probability is `Climatology.predict(lot_id, ts, horizon_min=0)` --
    `horizon_min` is passed as `0` only for clarity; `Climatology.predict`
    ignores it entirely and keys solely on `week_bucket(ts)` and the shrinkage
    chain. Using the model's own `predict` rather than re-deriving a rate here
    is what keeps this table and the live forecast from ever silently
    drifting apart: same tiers, same shrinkage, same fallback from an empty
    bucket to the lot rate to the global one.

    The support is that bucket's own raw observation count -- the `total`
    half of `history.counts.bucket[(lot_id, bucket)]`'s `[hits, total]` pair,
    read BEFORE shrinkage touches it. `counts.bucket` is a `defaultdict`, and
    `Climatology` holds a live reference to the same dict this function reads,
    so a plain `[...]` lookup here would silently create a zeroed entry for
    every bucket this function merely asked about; `.get` is used instead so
    reading the table can never mutate the counts it reads from.

    A bucket with no observations for this lot still carries a real
    probability -- the shrinkage chain falls back to the lot rate, then the
    citywide one, and that continuity is the entire reason this artifact
    exists -- but its support is honestly `0`, never quietly promoted into
    "no data" by way of a nonzero-looking number. A lot the corpus has never
    seen ANYWHERE -- i.e. `history` itself has no observations, not even
    enough for the global tier -- gets `None` in every cell instead, because
    that is what `Climatology.predict` returns when it has no basis for an
    answer at all; `None` here is never a stand-in for a real `0`.
    """
    climatology = forecast.Climatology(history)
    bucket_counts = history.counts.bucket
    cells: dict[str, list[tuple[float | None, int]]] = {}
    for lot_id in lot_ids:
        row: list[tuple[float | None, int]] = []
        for bucket in range(config.WEEK_BUCKETS):
            ts = _bucket_timestamp(bucket)
            probability = climatology.predict(lot_id, ts, horizon_min=0)
            support = bucket_counts.get((lot_id, bucket), (0, 0))[1]
            row.append((probability, support))
        cells[lot_id] = row
    return cells
