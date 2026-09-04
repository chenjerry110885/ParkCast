"""Evaluate a forecaster across every lot and horizon into a compact matrix."""
from collections.abc import Sequence

from parkcast import config
from parkcast.forecast import Forecaster

UNKNOWN = 255


def horizons() -> tuple[int, ...]:
    return tuple(
        config.HORIZON_STEP_MIN * (i + 1) for i in range(config.HORIZON_COUNT)
    )


def build_grid(
    forecaster: Forecaster, lot_ids: Sequence[str], base_ts: int
) -> bytes:
    """Row-major `len(lot_ids) x HORIZON_COUNT` bytes of percent probabilities.

    255 means "no basis for an answer" and is deliberately distinct from 0,
    which means "certainly full". Collapsing the two would turn ignorance into
    a confident negative.
    """
    out = bytearray()
    for lot_id in lot_ids:
        for horizon_min in horizons():
            p = forecaster.predict(lot_id, base_ts + horizon_min * 60, horizon_min)
            if p is None:
                out.append(UNKNOWN)
            else:
                out.append(max(0, min(100, round(p * 100))))
    return bytes(out)
