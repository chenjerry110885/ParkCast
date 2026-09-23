"""The trained forecaster, and the gauntlet a model file runs before it is used.

This is the only file in the project written by one process and read by another,
which makes what the loader accepts a security decision rather than an
ergonomic one. `load` refuses anything it cannot fully account for and returns
None; the caller falls back to `Blend` and publishes anyway.

That asymmetry is deliberate and worth stating: **a model that cannot be
trusted must cost a worse forecast, never an outage.** Every refusal below is
silent to the site's visitors and loud in the log.

What it refuses, and why each one matters
------------------------------------------
* **No manifest, or an unreadable one.** The manifest is what the digest and
  the feature order live in; without it there is nothing to check the model
  against, and an unchecked model is the thing this module exists to prevent.
* **A digest mismatch.** Catches a truncated write the rename should already
  have prevented, a corrupted file, and a substituted one.
* **Anything that is not LightGBM's text format.** `pickle` and `joblib`
  deserialise to arbitrary code. The digest alone would not save us if an
  attacker could write both files, so the header is checked independently.
* **A feature order that is not ours.** The worst failure available: every
  value fed to the wrong split, and perfectly plausible probabilities out the
  other side. Nothing downstream could detect it.
* **A model trained through a date more than `STALE_AFTER_SEC` ago.** A trainer
  dead for a fortnight should stop serving rather than keep answering from a
  world that has moved on.
"""
import hashlib
import logging
import time
from collections.abc import Mapping, Sequence
from pathlib import Path

import lightgbm as lgb
import numpy as np

from parkcast import features, train

log = logging.getLogger(__name__)

#: How old a model may be before it stops serving. Longer than the longest
#: intentional pause -- the collector is paused while the machine is gaming --
#: and far shorter than a season, so a model cannot quietly outlive the
#: behaviour it learnt.
STALE_AFTER_SEC = 14 * 86400

#: Every LightGBM text model begins here. A pickle begins with 0x80, a joblib
#: archive with "PK" or a zlib header; none of them survive this check.
_TEXT_HEADER = b"tree"


def load(model_dir, *, now: int | None = None) -> lgb.Booster | None:
    """The live model, or None with a reason in the log.

    Never raises. Every caller is either inside a 300-second poll slot or inside
    a nightly job, and neither can afford an exception from a file that is
    allowed to be absent.
    """
    now = int(time.time()) if now is None else now
    model_dir = Path(model_dir)
    path = model_dir / "current.txt"

    manifest = train.manifest(model_dir)
    if not manifest:
        log.info("no usable model manifest in %s; falling back", model_dir)
        return None
    if not path.exists():
        log.warning("manifest in %s names a model that is not there", model_dir)
        return None

    recorded = manifest.get("features")
    if recorded != list(features.FEATURES):
        log.error("model in %s was built for a different feature set; refusing", model_dir)
        return None

    trained_through = manifest.get("trained_through")
    if not isinstance(trained_through, int) or now - trained_through > STALE_AFTER_SEC:
        log.error("model in %s was trained through %s and is too old to serve",
                  model_dir, trained_through)
        return None

    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest.get("sha256"):
        log.error("model in %s does not match its manifest digest; refusing", model_dir)
        return None
    if not raw.startswith(_TEXT_HEADER):
        log.error("model in %s is not LightGBM text; refusing to deserialise it", model_dir)
        return None

    try:
        return lgb.Booster(model_file=str(path))
    except Exception:
        # Whatever LightGBM's parser makes of a well-digested but malformed
        # file, the collector survives it.
        log.exception("model in %s would not parse; falling back", model_dir)
        return None


class Trained:
    """`P(free_car >= 1)` from the nightly model, or None when it cannot say.

    Same `predict` signature as `Persistence`, `Climatology` and `Blend`, so it
    drops into `grid.build_grid` and `evaluate.FORECASTERS` unchanged. It needs
    more to construct than they do -- a model directory and the roster -- which
    is why it is built by a caller that has both rather than by `cls(history)`.

    `available` is separate from a None prediction on purpose. "The model has
    nothing to say about this lot" and "there is no model" call for different
    responses: the first is one UNKNOWN cell, the second means fall back to
    `Blend` for the whole grid.
    """

    def __init__(
        self,
        history,
        *,
        model_dir,
        lots: Mapping[str, object],
        clim,
        neighbours: Mapping[str, Sequence[str]] | None = None,
        now: int | None = None,
        booster: lgb.Booster | None = None,
    ) -> None:
        self._history = history
        self._lots = lots
        self._clim = clim
        self._neighbours = neighbours or {}
        # `booster` skips the load for a caller that already did it -- scoring a
        # validation day rebuilds the history at every origin, and re-reading
        # and re-hashing the model file 48 times would be waste, not diligence.
        # The file is still verified, once, by whoever passed it in.
        self._booster = load(model_dir, now=now) if booster is None else booster

    @property
    def available(self) -> bool:
        return self._booster is not None

    def predict(self, lot_id: str, target_ts: int, horizon_min: int) -> float | None:
        lot = self._lots.get(lot_id)
        if self._booster is None or lot is None:
            return None

        origin_ts = target_ts - horizon_min * 60
        values = features.row(self._history, self._clim, lot, origin_ts=origin_ts,
                              horizon_min=horizon_min,
                              neighbours=self._neighbours.get(lot_id, ()))

        # No current reading and no climatology behind the bucket is no basis at
        # all, and a row of almost-nothing would still produce a number. `0%`
        # and `no data` are different statements; the grid writes UNKNOWN for
        # the second, and this is where that distinction is kept.
        row = dict(zip(features.FEATURES, values))
        if row["free_now"] is None and row["clim_p"] is None:
            return None

        x = np.array([[np.nan if v is None else v for v in values]], dtype=np.float32)
        return float(self._booster.predict(x)[0])
