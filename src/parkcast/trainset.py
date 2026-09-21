"""Training rows: sampled origins, frozen readings filtered, labels attached.

Read-only over the corpus
-------------------------
`liveness.py` states the rule: "The readings are still collected and stored
exactly as the feed sent them. Judging a lot frozen is a decision about what to
*publish*." Training is the third place that has to make the same judgement --
after publishing and after scoring -- and it makes it the same way: by filtering
what it reads. Nothing here writes to the store, and a reading dropped from a
training set is still a reading in the corpus.

Why the frozen filter lives here and not in `load_history`
----------------------------------------------------------
`config.NOT_UPDATING_AFTER_SEC` is 24 hours, so a frozen run spans day
boundaries and detecting one needs a lot's whole series in order.
`load_history`'s scan is deliberately unordered -- the `ORDER BY` it avoids
measured 11.19 s against 0.16 s on the live store -- and it runs inside a
300-second poll slot. This runs nightly, out of process, with no such budget, so
it can afford the ordered pass. The separate question of frozen readings in
`Counts` is deliberately still open; see the Stage B spec, section 4.2.

Sampling
--------
Expanding every (lot, slot, horizon) is ~7.5M rows per day for Taipei alone and
~127M over seventeen days. Origins are therefore sampled on the same cadence the
backtest samples them -- one every 30 minutes -- which brings seventeen days to
about 4.4M rows. `sample_origins` is `evaluate.choose_origins` with that cadence
as its default, reused rather than reimplemented so training and scoring cannot
drift apart about what an origin is.
"""
from collections.abc import Mapping, Sequence
from typing import NamedTuple

from parkcast import config, features
from parkcast.evaluate import choose_origins


class Row(NamedTuple):
    """One training example. `label` is None when no observation exists at the
    target -- which is every serving row, by definition, and some training ones
    where the feed missed a slot. The trainer drops those; nothing else has to.
    """
    values: list[float | None]
    label: int | None
    lot_id: str
    origin_ts: int
    horizon_min: int


def frozen_spans(
    stamps: Sequence[int],
    values: Sequence[int],
    *,
    threshold_sec: int = config.NOT_UPDATING_AFTER_SEC,
) -> list[tuple[int, int]]:
    """Every maximal run of identical readings lasting at least `threshold_sec`,
    as inclusive `(first_ts, last_ts)` pairs.

    `liveness.unchanged_run` is the same notion and stays the authority on it,
    but it reports only the run ending at the newest reading -- which is all
    publishing needs, because publishing asks "is this lot stuck *now*". A
    training set has to ask the question at every past origin, so this
    generalises it to every run in the series.
    `test_the_trailing_span_agrees_with_the_serving_rule` pins them together
    where they overlap, so the two cannot drift.

    `stamps` and `values` are ascending and already free of nulls, which is what
    `evaluate.reading_series` produces: a missing reading says nothing about
    whether the value changed, so it neither ends a run nor counts towards one.
    """
    spans: list[tuple[int, int]] = []
    start = 0
    for i in range(1, len(stamps) + 1):
        if i < len(stamps) and values[i] == values[start]:
            continue
        if stamps[i - 1] - stamps[start] >= threshold_sec:
            spans.append((stamps[start], stamps[i - 1]))
        start = i
    return spans


def _inside(spans: Sequence[tuple[int, int]], ts: int) -> bool:
    return any(first <= ts <= last for first, last in spans)


def sample_origins(labels, *, every_minutes: int = 30, start_ts: int = 0,
                   limit: int | None = None) -> list[int]:
    """Origins at the sampling cadence, from timestamps that have readings.

    A thin default over `evaluate.choose_origins` rather than a second
    implementation: if training and scoring disagreed about what an origin is,
    every comparison between them would be off and nothing would say so.
    """
    return choose_origins(labels, start_ts=start_ts, every_minutes=every_minutes,
                          limit=limit)


def iter_rows(
    history,
    clim,
    lots: Sequence,
    *,
    origins: Sequence[int],
    horizons: Sequence[int],
    labels: Mapping[int, Mapping[str, int]] | None = None,
    neighbours: Mapping[str, Sequence[str]] | None = None,
    reading_series: Mapping[str, tuple[Sequence[int], Sequence[int]]] | None = None,
    exclude_frozen: bool = True,
) -> list[Row]:
    """Rows for every (lot, origin, horizon), minus anything frozen, one at a time.

    `reading_series` is a lot's whole ascending `(stamps, values)` -- what
    `evaluate.reading_series` returns -- and is what frozen-run detection needs;
    `history.recent` cannot serve, because it holds only the newest
    `config.HISTORY_TAIL` readings, two hours at a five-minute cadence, against
    a 24-hour threshold.

    Leaving it out while `exclude_frozen` is on RAISES rather than quietly
    training on everything. A filter that silently does nothing when its input
    is missing is the shape of bug that produces a confidently wrong model and
    no failure anywhere -- so the serving path, which genuinely wants no
    filtering because `liveness` has already withheld the frozen lots, says
    `exclude_frozen=False` and says it out loud.

    A generator, not a list: see `rows` for what materialising one costs.

    A row is dropped when EITHER its origin or its target falls inside a frozen
    run. The origin would give it fictional persistence features; the target
    would give it a fictional label. Both are worth dropping, and dropping on
    the target alone would keep rows that teach the model a stuck lot is
    predictable.
    """
    if exclude_frozen and reading_series is None:
        raise ValueError(
            "exclude_frozen needs reading_series (evaluate.reading_series gives it); "
            "pass exclude_frozen=False to build rows without the filter"
        )
    neighbours = neighbours or {}

    for lot in lots:
        spans = ()
        if exclude_frozen and lot.id in reading_series:
            stamps, values = reading_series[lot.id]
            spans = frozen_spans(stamps, values)
        near = tuple(neighbours.get(lot.id, ()))

        for origin_ts in origins:
            if spans and _inside(spans, origin_ts):
                continue
            for horizon_min in horizons:
                target_ts = origin_ts + horizon_min * 60
                if spans and _inside(spans, target_ts):
                    continue
                free = None if labels is None else labels.get(target_ts, {}).get(lot.id)
                yield Row(
                    values=features.row(history, clim, lot, origin_ts=origin_ts,
                                        horizon_min=horizon_min, neighbours=near),
                    label=None if free is None else int(free >= 1),
                    lot_id=lot.id,
                    origin_ts=origin_ts,
                    horizon_min=horizon_min,
                )


def rows(*args, **kwargs) -> list[Row]:
    """`iter_rows` materialised. Convenient, and the wrong call for a real fit.

    Measured on a synthetic seventeen-day corpus: Taipei's 1,082 lots at 816
    sampled origins and five horizons is **4,414,560 rows and 3.8 GB** -- 913
    bytes each, because a `Row` holds a Python list of 26 boxed floats. That is
    comfortably past the trainer's 2 GB memory cap, so `train.py` streams
    `iter_rows` into a float32 array instead, where the same rows cost 459 MB.

    Kept because tests and small callers want a list, and because a definition
    you can hold in one expression is worth having.
    """
    return list(iter_rows(*args, **kwargs))
