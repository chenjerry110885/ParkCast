# ParkCast — Stage B: a trained model that keeps learning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The prerequisites todo is archived at `docs/superpowers/plans/2026-09-21-stage-b-prerequisites-archive.md`. Both landed 2026-09-21: `Q.ASSUMED_TS` records timestamp provenance, and the disk is measured at 65.4 MB/month against a 150–400 MB/month estimate.

**Goal:** A LightGBM classifier that replaces `Blend` in the published grid for Taipei, refit nightly from scratch, and never adopted without beating the model it would replace on a day it has never seen.

**Architecture:** One feature builder shared by training and serving, so the two cannot drift. A trainer in its own offline container that writes a text model plus a digest manifest. A `Trained` forecaster in the collector that verifies the digest, predicts, and falls back to `Blend` on anything unexpected. An adoption gate between them that is allowed to say no.

**Tech Stack:** Python 3.13+, LightGBM via its native API, numpy. No scikit-learn, no scipy, no pickle.

**Spec:** [`docs/superpowers/specs/2026-09-21-stage-b-trained-model-design.md`](../docs/superpowers/specs/2026-09-21-stage-b-trained-model-design.md)

**Buildable now, adoptable later.** Tasks 1–8 are built and tested on synthetic data and need no corpus depth. Only Task 9 — the first real adoption and the publish switch — waits for the corpus, whose own bar is three days behind every half-hour-of-week bucket, targeted around 2026-10-01.

## Global Constraints

- **Never read or write anything under `data/`.** A live collector owns it. Tests use `tmp_path`; scripts take paths as arguments and the user runs them.
- **Never unpickle a model.** `pickle` and `joblib` deserialise to arbitrary code. LightGBM's own `save_model` / `Booster(model_file=…)` text format only. A test asserts the loader refuses anything else.
- **No leak.** A forecaster at origin `T` sees only data strictly before `T`. For this model, strictly before the boundary of `T`'s preceding day.
- **`None` is not `0`.** A model with no basis returns `None`, which the grid writes as `UNKNOWN = 255`. A missing feature stays missing; LightGBM handles it natively and it is never imputed to `0`.
- **The corpus stays a faithful record of the feed.** Frozen readings are filtered where the training rows are built, never removed from the store.
- **Determinism.** `deterministic: true`, `force_row_wise: true`, `num_threads: 1`, fixed `seed`. Two fits on the same data must be byte-identical or the backtest means nothing.
- **Taipei only.** `ids.LEGACY_CITY`. Other cities need a dated roster history first (spec §10).
- **No `Co-Authored-By:` trailers and no AI attribution of any kind in commit messages** (CLAUDE.md).
- Python suite: `docker run --rm --user 0:0 -v "D:/Projects/ParkCast/src:/repo/src:ro" -v "D:/Projects/ParkCast/tests:/repo/tests:ro" -v "D:/Projects/ParkCast/scripts:/repo/scripts:ro" -v "D:/Projects/ParkCast/web/tests:/repo/web/tests:ro" -v "D:/Projects/ParkCast/pyproject.toml:/repo/pyproject.toml:ro" -w /repo -e PYTHONDONTWRITEBYTECODE=1 docker-collector:latest sh -c "pip install -q pytest 2>/dev/null; python -m pytest -q -p no:cacheprovider tests/"`

## File structure

| file | responsibility |
|---|---|
| `src/parkcast/features.py` | **new.** One row of features from one `(history, lot, origin, horizon)`. The single definition, used by trainer and server alike. |
| `src/parkcast/trainset.py` | **new.** Sample origins, build rows, exclude frozen runs, respect the cutoff. |
| `src/parkcast/model.py` | **new.** `Trained` forecaster: load, verify, predict, refuse. |
| `src/parkcast/train.py` | **new.** Fit, validate against the incumbent, adopt or decline. Entry point for the trainer container. |
| `src/parkcast/evaluate.py` | modify: `FORECASTERS` gains `trained`; the backtest refits per day boundary. |
| `src/parkcast/scheduler.py` | modify: load the model at publish, fall back to `Blend`. |
| `docker/docker-compose.yml` | modify: the `trainer` service. |
| `pyproject.toml` | modify: `lightgbm`, `numpy`. |

---

### Task 1: The dependency, and the image that has to carry it

Everything downstream needs LightGBM importable inside the test image, so this is first and it is mostly an image rebuild. `numpy` is **not** currently present — pyarrow 25 dropped the requirement — so both packages are new.

**Files:**
- Modify: `pyproject.toml`
- Test: `tests/test_deps.py` (new)

**Interfaces:**
- Produces: `lightgbm` and `numpy` importable in both the collector and the test image.

- [ ] **Step 1: Write the failing test**

Create `tests/test_deps.py`:

```python
"""The two packages Stage B adds, and the one format it must never load.

A dependency test looks trivial until an image is rebuilt without it and the
failure surfaces as a forecaster silently falling back to Blend in production.
"""


def test_lightgbm_and_numpy_are_importable():
    import lightgbm
    import numpy

    assert lightgbm.__version__
    assert numpy.__version__


def test_lightgbm_is_used_through_its_native_api_not_sklearn():
    """The sklearn wrapper would pull in scikit-learn and scipy for nothing we
    use -- ~90 MB against ~22 MB. Importing it must not be necessary."""
    import lightgbm

    assert hasattr(lightgbm, "train"), "the native API is what this project uses"
    assert hasattr(lightgbm, "Dataset")
    assert hasattr(lightgbm, "Booster")
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `ModuleNotFoundError: No module named 'lightgbm'`.

- [ ] **Step 3: Declare the dependencies**

In `pyproject.toml`, extend `dependencies` and explain the choice where the next reader will look:

```toml
# lightgbm/numpy are Stage B's. The NATIVE lightgbm API is used, never the
# scikit-learn wrapper: the wrapper would pull in scikit-learn and scipy for
# nothing this project calls, ~90 MB against ~22 MB. numpy is genuinely new --
# pyarrow 25 dropped its numpy requirement, so it was not already here.
# Both are needed by the collector, not only the trainer, because inference
# runs in-process at publish time.
dependencies = [
    "requests>=2.32", "certifi", "pyarrow>=17", "pyproj>=3.6",
    "lightgbm>=4.5", "numpy>=2.1",
]
```

- [ ] **Step 4: Rebuild the image and run the test**

```bash
docker build -t docker-collector:latest -f docker/Dockerfile .
```

Then the suite. Expected: PASS.

- [ ] **Step 5: Confirm the collector still starts**

A new C extension in the process that talks to six external feeds is worth one direct check:

```bash
docker run --rm docker-collector:latest python -c "import parkcast, lightgbm, numpy; print('ok')"
```

- [ ] **Step 6: Record the image size change**

Measure before and after (`docker images docker-collector:latest`), and put the delta in the commit message. The spec predicts ~22 MB; a number far off that means something else came along and should be looked at, not accepted.

**It was far off, and something had.** Measured **460 MB → 763 MB, +303 MB**. LightGBM 4.7's core requirements are `narwhals`, `numpy` and **`scipy`** — scikit-learn is only an extra, so the native API avoids scikit-learn but never avoided scipy, which is what the estimate assumed. The image also needs `libgomp1` from apt, because the manylinux wheel links against the GNU OpenMP runtime that `python:3.13-slim` omits; without it `import lightgbm` fails inside `ctypes`, at import rather than install, which in the collector reads as the forecaster quietly falling back to `Blend`. Both are recorded in spec §9.2. The choice stands — `HistGradientBoostingClassifier` needs all of this plus scikit-learn — but the real number is an order of magnitude above the estimate.

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml tests/test_deps.py
git commit -m "build: add lightgbm and numpy for Stage B"
```

---

### Task 2: One feature builder, used by both sides

**The bug this task exists to prevent is training/serving skew** — the trainer computing a feature one way and the collector another, producing a model that scores well offline and badly in production, with nothing failing. The only reliable defence is that both call the same function, and a test that proves they do.

**Files:**
- Create: `src/parkcast/features.py`
- Test: `tests/test_features.py`

**Interfaces:**
- Consumes: `forecast.History`, `forecast.Climatology`, `metadata.Lot`, `pricing`
- Produces:
  - `FEATURES: tuple[str, ...]` — the order, which the manifest records and the loader checks
  - `row(history, clim, lot, origin_ts, horizon_min, neighbours) -> list[float | None]`
  - `CATEGORICAL: tuple[str, ...]` — names LightGBM is told are categorical

- [ ] **Step 1: Write the failing tests**

```python
def test_the_feature_order_is_fixed_and_named():
    # The manifest records this order and the loader refuses a model whose
    # order differs. A silent reordering would feed every value to the wrong
    # split and still produce plausible probabilities.
    assert features.FEATURES[0] == "horizon_min"
    assert len(set(features.FEATURES)) == len(features.FEATURES)


def test_a_row_has_one_value_per_named_feature():
    r = features.row(history, clim, lot, origin_ts=1_700_000_000, horizon_min=15,
                     neighbours=())
    assert len(r) == len(features.FEATURES)


def test_an_unknown_capacity_stays_missing_rather_than_zero(...):
    # 0 means "this lot has no spaces". None means "we do not know how many".
    # Imputing the first to the second teaches the model a lot is always full.
    r = dict(zip(features.FEATURES, features.row(..., lot=lot_without_capacity, ...)))
    assert r["capacity_car"] is None


def test_a_lot_with_no_current_reading_still_produces_a_row(...):
    # Climatology may still have something to say. The row exists; the
    # persistence-derived features are missing.
    r = dict(zip(features.FEATURES, features.row(..., lot=unseen_lot, ...)))
    assert r["free_now"] is None
    assert r["clim_p"] is not None


def test_no_feature_reads_a_observation_at_or_after_the_origin(history_with_future):
    """The leak test. Every feature is computed from a History built with
    before_ts, so this is really a test that nothing reaches around it."""
    at_origin = features.row(history_before, clim_before, lot, origin_ts=T, horizon_min=15,
                             neighbours=())
    with_future = features.row(history_with_future, clim_before, lot, origin_ts=T,
                               horizon_min=15, neighbours=())
    assert at_origin == with_future
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL, module does not exist.

- [ ] **Step 3: Write `features.py`**

The feature set is spec §3.3. Group it exactly as the spec does and name each group in the module docstring, with the reason it is there — particularly `clim_p` and `clim_support`, which exist so the model can learn to distrust a thin or frozen bucket rather than needing those rows removed.

`FEATURES` is a module-level tuple; `row` returns values in that order and nothing else defines the order.

- [ ] **Step 4: Run them to verify they pass**

- [ ] **Step 5: Write the skew test**

```python
def test_training_and_serving_build_the_identical_row(...):
    """Training/serving skew is the failure that produces a model which scores
    well offline and badly in production with nothing raising. The defence is
    that there is one function; this asserts the trainer has not grown its own.
    """
    from parkcast import trainset      # Task 3, imported here deliberately
    serving = features.row(history, clim, lot, origin_ts=T, horizon_min=15, neighbours=n)
    training = trainset.rows(history, clim, [lot], origins=[T], horizons=[15])[0].values
    assert training == serving
```

Mark it `@pytest.mark.xfail(reason="trainset arrives in Task 3", strict=False)` until Task 3 lands, then remove the marker in Task 3's commit. Do not delete the test.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(model): one feature builder, so training and serving cannot drift"
```

---

### Task 3: The training set, sampled and leak-free

**Files:**
- Create: `src/parkcast/trainset.py`
- Test: `tests/test_trainset.py`

**Interfaces:**
- Consumes: `features.row`, `forecast.load_history`, `forecast.by_city`, `liveness.unchanged_run`
- Produces:
  - `Row = namedtuple("Row", "values label lot_id origin_ts horizon_min")`
  - `rows(history, clim, lots, *, origins, horizons) -> list[Row]`
  - `sample_origins(labels, *, every_minutes=30) -> list[int]`
  - `frozen_spans(series, *, threshold_sec) -> list[tuple[int, int]]`

- [ ] **Step 1: Write the failing tests**

```python
def test_a_frozen_run_is_excluded_from_training(...):
    """A stuck feed repeating one number teaches the model that lot is
    perfectly predictable. The app already withholds these from publishing and
    the backtest from scoring; training is the third place that must."""


def test_the_readings_either_side_of_a_frozen_run_are_kept(...):
    # Excluding the lot entirely would discard the evidence that matters most.


def test_a_frozen_run_is_filtered_not_deleted(conn, ...):
    """`liveness.py`: the corpus stays a faithful record of the feed. After
    building a training set the store must be byte-for-byte what it was."""


def test_no_row_uses_a_reading_at_or_after_its_own_origin(...):
    # The leak test, at the level the rows are built rather than the features.


def test_the_row_count_matches_the_sampling_arithmetic(...):
    # lots x origins x horizons, so a change in sampling is visible as a number
    # rather than as a slower fit.
```

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

`frozen_spans` reuses `liveness.unchanged_run`'s notion of a run rather than reimplementing it, and takes `config.NOT_UPDATING_AFTER_SEC` as the threshold. Runs span day boundaries (the threshold is 24 h), so detection walks a lot's whole series in order — affordable here, and the reason this lives in the trainer rather than in `load_history` (spec §4.2).

Sampling is spec §4.2: one origin every 30 minutes, all lots, horizons `(5, 15, 30, 60, 120)`. The docstring carries the arithmetic — 1,082 × 48 × 17 × 5 ≈ 4.4M rows against 127M unsampled — so the next person to widen it knows what they are buying.

- [ ] **Step 4: Run them to verify they pass**

- [ ] **Step 5: Un-xfail the skew test from Task 2 and run it**

- [ ] **Step 6: Measure, and write the number down**

Build a training set over a synthetic 17-day, 1,000-lot corpus. Record rows, wall-clock and peak RSS in the commit message. If memory exceeds ~1 GB, chunk by day before moving on rather than after.

- [ ] **Step 7: Commit**

---

### Task 4: The trainer, and a fit that reproduces exactly

**Files:**
- Create: `src/parkcast/train.py` (fit + save only; the gate is Task 6)
- Test: `tests/test_train.py`

**Interfaces:**
- Produces:
  - `PARAMS: dict` — the pinned LightGBM config
  - `fit(rows) -> lightgbm.Booster`
  - `save(booster, out_dir, *, trained_through, feature_order, scores) -> Path`
  - `manifest(path) -> dict`

- [ ] **Step 1: Write the failing tests**

```python
def test_two_fits_on_the_same_data_are_byte_identical(tmp_path):
    """Without this the backtest is meaningless: it claims to reconstruct the
    model as it would have been at T, and a fit that varies run to run cannot
    be reconstructed. Multi-threaded histogram building is the known source,
    which is why num_threads is pinned to 1."""
    a = train.fit(rows).model_to_string()
    b = train.fit(rows).model_to_string()
    assert a == b


def test_the_pinned_params_are_the_ones_determinism_needs():
    assert train.PARAMS["deterministic"] is True
    assert train.PARAMS["force_row_wise"] is True
    assert train.PARAMS["num_threads"] == 1
    assert isinstance(train.PARAMS["seed"], int)


def test_the_manifest_digest_matches_the_model_on_disk(tmp_path):
    path = train.save(booster, tmp_path, trained_through=..., feature_order=features.FEATURES,
                      scores={})
    recorded = train.manifest(path)["sha256"]
    assert recorded == hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_manifest_records_the_feature_order(tmp_path):
    # A model whose feature order differs from the caller's would feed every
    # value to the wrong split and still return plausible probabilities.
    assert train.manifest(path)["features"] == list(features.FEATURES)


def test_the_model_is_written_atomically(tmp_path, monkeypatch):
    # A reader must never see a half-written model: write to a temp name in the
    # same directory, then rename.
```

- [ ] **Step 2–4: Run, implement, run**

`PARAMS` carries the spec §3.1 pins with a comment on each saying what it buys. `save` writes `current.txt` and `manifest.json` via temp-and-rename, keeping the last 7 (spec §5) so a rollback is a rename.

- [ ] **Step 5: Commit**

---

### Task 5: The `Trained` forecaster, and what it refuses

**Files:**
- Create: `src/parkcast/model.py`
- Test: `tests/test_model.py`

**Interfaces:**
- Consumes: `features.row`, `train.manifest`
- Produces: `Trained(history, model_dir)` implementing the same `predict(lot_id, target_ts, horizon_min) -> float | None` as every other forecaster; `load(model_dir) -> Booster | None`

- [ ] **Step 1: Write the failing tests**

```python
def test_a_tampered_model_is_refused(tmp_path):
    """The digest is the difference between serving a corrupted or substituted
    model and noticing one."""
    path = train.save(...)
    path.write_text(path.read_text() + "\n# edited\n")
    assert model.load(tmp_path) is None


def test_a_pickle_is_never_loaded(tmp_path):
    """pickle and joblib deserialise to arbitrary code, and this file is
    written by a background job and read by the collector. The format is a
    code-execution decision, so it is pinned by a test."""
    (tmp_path / "current.txt").write_bytes(pickle.dumps({"evil": True}))
    assert model.load(tmp_path) is None


def test_a_missing_model_is_not_an_error(tmp_path):
    assert model.load(tmp_path) is None


def test_a_model_older_than_the_staleness_bound_is_refused(tmp_path):
    # A trainer dead for a fortnight should not keep serving. 14 days: longer
    # than the longest intentional pause, far shorter than a season.


def test_a_feature_order_mismatch_is_refused(tmp_path):
    # Silent misalignment produces plausible numbers, which is the worst case.


def test_no_basis_returns_none_not_a_number(...):
    """A lot with no current reading AND no climatology support gets None, which
    the grid writes as UNKNOWN. A model must never manufacture a probability
    from an empty row -- `0%` and `no data` are different statements."""
    assert Trained(history, tmp_path).predict("taipei:UNSEEN", target, 15) is None
```

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

---

### Task 6: The adoption gate

**The load-bearing safety property of this design.** A model that retrains nightly can degrade nightly; this is what is allowed to say no.

**Files:**
- Modify: `src/parkcast/train.py`
- Test: `tests/test_train_gate.py`

**Interfaces:**
- Produces: `nightly(conn, cold_dir, *, city, day, model_dir) -> Decision` with `Decision(adopted: bool, reason: str, scores: dict)`

- [ ] **Step 1: Write the failing tests**

```python
def test_a_candidate_worse_than_the_incumbent_is_not_adopted(...):
    decision = train.nightly(...)
    assert not decision.adopted
    assert "incumbent" in decision.reason


def test_a_candidate_that_loses_to_persistence_is_not_adopted(...):
    # Beating the incumbent is not enough if both are worse than the baseline.


def test_the_artifact_validated_is_the_artifact_written(tmp_path):
    """Training on < D-1 and validating on [D-1, D) ships a model one day
    staler than it could be. The alternative -- validate one fit, refit on < D,
    ship that -- ships a model nobody ever scored. Freshness comes from the
    features, not the weights (spec 4.1), so the stale day costs nothing and
    never shipping an unvalidated artifact is worth more."""
    assert written_digest == validated_digest


def test_the_validation_day_is_never_in_the_training_data(...):
    # The gate's own leak test. A candidate scored on data it trained on would
    # pass every night, which is worse than having no gate.


def test_a_rejection_keeps_the_incumbent_untouched(tmp_path):
    before = (model_dir / "current.txt").read_bytes()
    train.nightly(...)
    assert (model_dir / "current.txt").read_bytes() == before


def test_consecutive_rejections_are_visible(...):
    # A run of rejections is itself a signal; it must reach report.py rather
    # than only a log line nobody reads.
```

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Commit**

---

### Task 7: Into the evaluation

**Files:**
- Modify: `src/parkcast/evaluate.py`, `scripts/evaluate-forecast.py`
- Test: `tests/test_evaluate.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_the_backtest_refits_per_day_boundary_not_per_origin(...):
    """Per-origin refitting would score a model fresher than the one users get
    and flatter it. Refitting on the cadence production uses is both cheaper --
    days, not origins, many fits -- and more faithful."""


def test_the_trained_forecaster_is_scored_alongside_the_others(...):
    assert "trained" in result.by_model


def test_an_origin_with_no_model_yet_scores_the_baselines_anyway(...):
    # Early origins precede the first nightly fit. They must not vanish from
    # the other forecasters' samples, or the comparison stops being like-for-like.
```

- [ ] **Step 2–4: Run, implement, run**

`FORECASTERS` gains `("trained", ...)`. Note it cannot be a bare class like the others — it needs a model directory — so the tuple's shape changes; keep the change minimal and update the three places that unpack it.

- [ ] **Step 5: Commit**

---

### Task 8: The trainer container

**Files:**
- Modify: `docker/docker-compose.yml`
- Create: `docker/trainer.Dockerfile` if the collector image proves unsuitable; prefer reusing it.

- [ ] **Step 1: Add the service**

Spec §9.3, and every line of it is a security decision:

```yaml
  trainer:
    image: docker-collector:latest
    command: ["python", "-m", "parkcast.train"]
    # Training makes no network call, so denying egress removes the whole
    # exfiltration and runtime-supply-chain class at once.
    network_mode: none
    volumes:
      - ../data/cold:/app/data/cold:ro
      - ../data/hot.sqlite:/app/data/hot.sqlite:ro
      - ../data/models:/app/data/models
    # The collector deliberately has no memory limit; the trainer is the
    # component that could run away on a shared laptop, so it is the one bounded.
    mem_limit: 2g
    restart: "no"
```

It receives neither the Cloudflare deploy key nor the upload secret; confirm no `env_file` or `environment` entry reaches it.

- [ ] **Step 2: Verify the isolation rather than assume it**

```bash
docker compose -f docker/docker-compose.yml run --rm trainer python -c "
import socket
try:
    socket.create_connection(('1.1.1.1', 53), timeout=3); print('NETWORK REACHABLE -- WRONG')
except OSError as e: print('no network, as intended:', e.__class__.__name__)"
```

And that the corpus mount is genuinely read-only:

```bash
docker compose -f docker/docker-compose.yml run --rm trainer python -c "
try:
    open('/app/data/cold/probe','w'); print('WRITABLE -- WRONG')
except OSError as e: print('read-only, as intended:', e.__class__.__name__)"
```

- [ ] **Step 3: Commit**

---

### Task 9: Shadow, then switch — Taipei only

**Waits for the corpus.** Everything above is testable on synthetic data; this is the task that needs real depth, and its bar is the evaluation's own: three days behind every half-hour-of-week bucket. Check with `python scripts/corpus-coverage.py --city taipei`.

- [ ] **Step 1: Run the corrected evaluation and record the baseline**

```bash
python scripts/evaluate-forecast.py --city taipei
```

This is the first run since the per-city scoping fix, so **the numbers in `docs/state-of-play.md` are not the baseline** — they were produced by an unscoped backtest. Record the new ones before the model exists, or there is nothing to compare against.

- [ ] **Step 2: Shadow for a week**

The trainer runs nightly and the gate decides; nothing is published from the model. Record each night's decision. A week of passing gates is the entry condition for step 3 — not a good Brier on one night.

- [ ] **Step 3: Check the ship gate (spec §7)**

On the hard subset, per horizon: beats `Persistence` **and** `Climatology`; closes the mid-band calibration defect (0.8–0.9 says 0.862, happens 0.791) rather than moving it; does not regress the 0.9–1.0 band, where 85% of the mass lives.

**Failing any of these, `Blend` stays in the grid and the model stays in the table.** A trained model that does not beat the baseline is a finding, and writing it up is the deliverable in that case.

- [ ] **Step 4: Switch the published grid for Taipei, and release**

`deploy:check` then `deploy:release`, from the repository root.

- [ ] **Step 5: Write up what happened in `docs/state-of-play.md`**

Under "The evaluations", with the same table shape as the existing runs, including the support stratification. A skill number without its support is not a result.

---

## Not in this plan

- **Other cities.** They need a dated roster history first; only Taipei has one (spec §10).
- **Frozen readings out of `Counts`.** Long deferred, moves every published probability, needs its own spec. Stage B does not depend on it.
- **Compressing the metadata snapshots** (89% of the cold store, near-identical day to day). Disk is not a constraint at 65.4 MB/month, so this stays deferred — but it is the same change that would unblock per-city metadata history.
- **Weather**, and any other external feature source: all are paid or rate-limited beyond what six cities × 5 minutes needs.
- **Hash-pinned dependencies.** Worth doing across all six, not just the two new ones; a separate change.
