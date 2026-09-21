# Stage B — a trained model that keeps learning

**Status:** proposed 2026-09-21
**Follows:** [`2026-09-16-stage-a-any-time-arrival-design.md`](2026-09-16-stage-a-any-time-arrival-design.md), which named this as its successor
**Depends on:** the per-city evaluation scoping landed 2026-09-21 (`c19de14`) — every number below is meaningless without it

## 0. What this is, and what it is not

A gradient-boosted classifier that replaces `Blend` in the published grid, retrained nightly on
everything collected so far, and never adopted without first proving itself against the model it
would replace.

It is **not** a rewrite of the forecasting layer. `Persistence`, `Climatology` and `Blend` all stay
exactly as they are: they remain the baselines the evaluation scores against, they remain the
fallback when no model file loads, and `Climatology`'s counts become one of the new model's inputs.
Stage B adds a fourth forecaster to `FORECASTERS` and a job that produces it.

It is also **not** a change to the ranker. Preferences (cheaper / balanced / closer) live in
`web/src/rank.ts` and stay there. The model emits a probability; the ranker turns a probability into
an expected cost. Keeping that seam is what lets either side change without re-deriving the other,
and it is why "the trained model should account for preferences" resolves to "the ranker already
does, using the model's output".

## 1. Why — what the evidence says is actually wrong

From `docs/state-of-play.md`, the 2026-09-14 run (231,536 predictions per forecaster, base rate
0.899). Blend already beats persistence by **+6.9%** at 5 minutes rising to **+21.9%** at 120. The
headline is not the opportunity. Two measured defects are:

1. **Calibration fails in the middle.** The 0.8–0.9 band says 0.862 and happens 0.791. The 0.6–0.7
   band says 0.657 and happens 0.520. The top band is sound (198,024 of 231,536 predictions, says
   0.986 against 0.976 observed) — so the app is honest about the easy cases and overconfident about
   exactly the ones a driver is deciding on.
2. **The hard subset is where the gain collapses.** On the 256 lots that actually fill up, blend's
   advantage over persistence falls from +16.3% to **+5.4%** at 60 minutes. That is the lot the
   product exists for.

A third thing the evidence shows is not a defect but a lever: **support dominates accuracy.**
Bucket n = 0 → Brier 0.1013; n = 1–5 → 0.0509; n = 6–19 → 0.0157. A model that is *told* how much
evidence is behind each prediction can learn to fall back when there is none, which is something
`Blend`'s fixed 30-minute half-life cannot express.

## 2. Constraints

Inherited and binding:

- **No data is never 0%.** A lot with no basis renders "no data". `UNKNOWN = 255` in the grid stays
  distinct from a real `0`. The model must be able to return `None`.
- **No leak, ever.** A forecaster at origin `T` may see only data strictly before `T` (the
  `load_history(before_ts=T)` contract in `forecast.py`). This is the constraint that shapes
  everything in §4 and §7.
- **No paid tier, no recurring cost.** No hosted training, no external feature APIs (which rules out
  weather for now — see §10).
- **One laptop.** The collector runs on OMEN_DESKTOP_YU and sleeps when the machine does. Memory
  after a six-city tick is 207 MiB.
- **The 300-second poll slot is not negotiable.** `run_forever` already warns that everything after
  the fetch loop — publishing six shards, compaction, prune — delays the next slot, and that an
  overrun past `target + 300` makes `next_poll_ts` skip a slot entirely. Nothing in this spec may run
  inside that loop. See §4.3.

New, and chosen here:

- **Nightly refit from scratch**, not online updates (§4.1).
- **LightGBM**, native API (§3.1). The dependency cost is measured in §9.
- **Nothing ships that was not validated as the exact artifact that ships** (§5).

## 3. The model

### 3.1 Class

LightGBM, binary objective, trained through the native `lgb.train` API rather than the scikit-learn
wrapper — the wrapper would pull in scikit-learn and scipy for nothing we use.

Why a GBT over the alternatives considered: the useful signal here is full of interactions that a
linear model cannot express without being told about them by hand — "a thin bucket matters more at
long horizons", "the current reading matters less for a lot that churns fast", "downtown at 18:00
behaves unlike the same clock time in a suburb". Trees find those without a feature-engineering
round per hypothesis. The cost is a dependency and a heavier nightly fit, both quantified below.

**Determinism is a hard requirement, not a preference.** The backtest must reproduce a model exactly
or §7 is worthless. Pinned in the training config: `deterministic: true`, `force_row_wise: true`,
`num_threads: 1`, and a fixed `seed`. Multi-threaded histogram construction is a known source of
run-to-run variation. A test trains the same data twice and asserts the serialised models are
byte-identical.

### 3.2 Target

Unchanged from every forecaster before it: `P(free_car >= 1)` at `target_ts`, for a given lot and a
given horizon. One model across all horizons, with `horizon_min` as a feature, rather than one model
per horizon — the horizons share almost all of their structure, and splitting them would divide the
training data 24 ways.

### 3.3 Features

One row is a `(lot, origin, horizon)` triple. LightGBM handles missing values natively, so an absent
feature stays absent rather than being imputed — which is the same honesty rule the rest of the
codebase follows, expressed in the model.

**From the current reading** (the persistence signal):
- `free_car` now, and `free_car / capacity_car` where capacity is known
- `is_free_now` (the exact quantity `Persistence` returns)
- minutes since this lot's last reading — staleness the app already reasons about in `liveness`
- trend: change in `free_car` over the last 15, 30 and 60 minutes

**From climatology** (stacking, not replacing):
- the shrunk probability `Climatology` would return for this lot and target bucket
- that bucket's support `n` — the lever identified in §1
- the lot's own historical free rate, and its `n`

**From the clock:**
- `horizon_min`
- sin/cos of time-of-day, and day-of-week

**From the lot:**
- `capacity_car`, `capacity_motor`, `charging`, `serves_cars`
- price per hour, as `pricing.py` parses it
- `lot_type` and `area`, as LightGBM native categoricals
- `city`, as a categorical

**From the neighbourhood:**
- mean free ratio of the *k* nearest lots at the origin (k = 5), and how many of them had a reading.
  District-level demand is the thing a per-lot model structurally cannot see, and it is what makes
  "everything around here is filling up" available as evidence.

### 3.4 Fallback

`Trained.predict` returns `None` when it has no basis — no current reading **and** no climatology
support for the bucket. It never manufactures a number from an empty row. The grid writes `UNKNOWN`,
exactly as it does for `Blend` today.

## 4. Training

### 4.1 Cadence: nightly, refit from scratch

Every night, discard the previous model and fit a new one on the corpus as it then stands.

The alternative — updating weights online as observations arrive — was rejected for one specific
reason. Online weights are **path-dependent**: they depend on the order observations arrived and how
many times each was seen. The question the backtest asks at every origin is "what would this model
have said at `T`?", and for a path-dependent model the only honest answer is to replay the entire
stream up to `T`, once per origin. That is not an evaluation anyone runs twice, and a model whose
evaluation stops being run is a model that cannot be defended.

A refit from scratch over data `< T` is a pure function of the corpus before `T`, which is the
existing `load_history(before_ts=T)` contract restated. The evaluation keeps working unchanged.

**Freshness does not come from the weights.** The model's weights are up to a day old; its *inputs*
are seconds old — the current reading, the trend, the neighbourhood, the climatology counts, all
recomputed every tick. This is why a day-stale model is not a stale forecast.

### 4.2 The training set, and its size

Naively expanding every `(lot, slot, horizon)` is not tractable and the arithmetic should be in the
spec rather than discovered later. Taipei alone, at 1,082 lots × 288 slots/day × 24 horizons, is
~7.5M rows **per day** of corpus — ~127M rows over 17 days.

So origins are **sampled**, exactly as the backtest samples them: one origin every 30 minutes (48 a
day), all lots, 5 horizons (5/15/30/60/120 min).

    1,082 lots × 48 origins × 17 days × 5 horizons ≈ 4.4M rows

At ~20 float32 features that is ~350 MB materialised, which is why the dataset is built in day-sized
chunks and handed to LightGBM incrementally rather than assembled whole. Sampling denser is a knob;
the plan should measure fit time and memory at 48/day before turning it.

**Frozen lots are excluded from training — at read time, never by touching the corpus.** A lot whose
feed has stuck repeats one number forever; trained on, it teaches the model that lot is perfectly
predictable, and the model learns to be confident exactly where the data is fictional. The app
already withholds these at serving time (`liveness.not_updating`) and the backtest already withholds
them from scoring. Training is the third place that has to, and this promotes "removing frozen lots
from the climatology counts" from the deferred list to a prerequisite.

How it must **not** be done is already written down. `liveness.py` states the rule: "The readings are
still collected and stored exactly as the feed sent them. Judging a lot frozen is a decision about
what to *publish*, and the corpus has to stay a faithful record of the feed." `Q.FROZEN` exists but
is explicitly "detected, not stored", because freezing is a property of a *run* of readings rather
than of any one of them, and persisting it would mean mutating rows already collected. So the
exclusion is a filter applied where the counts and the training rows are built, and a reading dropped
from training is still a reading in the store.

**Two different changes, and only one of them belongs to Stage B.** An earlier draft of this spec
conflated them:

* **Excluding frozen readings from the training set** is Stage B's, and it is local to the trainer.
  The trainer reads the corpus itself, nightly, out of process, with no 300-second budget — so it can
  afford the ordered two-pass that run detection needs, and nothing outside it is affected. This is a
  task in the Stage B plan, not a prerequisite.
* **Excluding frozen readings from `Counts`** — the long-deferred item — is a different change with
  real blast radius: it moves every published probability, climatology and blend alike, for every
  city. It is also genuinely hard in the place it would have to live. `NOT_UPDATING_AFTER_SEC` is 24
  hours, so a frozen run spans day boundaries; `load_history`'s scan is deliberately unordered (the
  `ORDER BY` it avoids costs 11.19 s against 0.16 s), and run detection needs order. It therefore
  wants its own spec and its own before/after measurement, and it stays deferred.

Stage B does not depend on the second. A model told *how much support is behind each prediction*
(§3.3) can learn to distrust a thin or frozen bucket on its own, which is a large part of why those
features are there.

### 4.3 Where it runs

**Not in `run_forever`.** A LightGBM fit inside the poll slot would eat the slot and, per the
`deadline` logic, potentially the one after it — trading collected data for a model trained on less
of it.

A separate process: its own compose service, sharing the data volume read-only for the corpus and
read-write for the model directory alone. It wakes after the collector has compacted a day, trains,
validates (§5), and writes or declines to write. A crash there cannot stop collection, which is the
property that matters most — the corpus is the irreplaceable asset.

## 5. The adoption gate

A model that retrains itself nightly can degrade itself nightly. Unattended retraining without a gate
is the single largest risk in this design.

Each night, for city C:

1. **Fit** a candidate on everything strictly before day boundary `D−1`.
2. **Validate** it on `[D−1, D)` — a full day the candidate has never seen — against three
   references: the incumbent model, `Blend`, and `Persistence`.
3. **Adopt** only if the candidate's Brier is no worse than the incumbent's, **and** it beats both
   `Persistence` and `Climatology`, **and** no calibration band with n ≥ 1,000 is off by more than
   0.05.
4. **Otherwise keep the incumbent** and log it loudly enough to show up in `report.py`. A run of
   consecutive rejections is itself a signal worth surfacing.

**The artifact validated is the artifact shipped.** Training on `< D−1` and validating on `[D−1, D)`
means the shipped model is one day staler than it could be. The alternative — validate one fit, then
refit on `< D` and ship *that* — ships a model no one ever scored. Given §4.1 (freshness comes from
features, not weights), one extra day of weight staleness costs approximately nothing, and never
shipping an unvalidated artifact is worth more.

The last 7 models per city are kept, so a rollback is a file rename.

## 6. Serving

- Model per city at `data/models/<city>/current.txt` (LightGBM's own text format) plus
  `manifest.json`: feature order, trained-through timestamp, validation scores, and the git commit of
  the trainer. Written to a temp name and renamed, so a reader never sees a half-written model.
- The collector loads it at publish time. 1,082 lots × 24 horizons × 6 cities ≈ 156k rows per tick,
  which LightGBM predicts in well under a second — but the plan measures it against the slot budget
  rather than assuming.
- **A missing or unreadable model falls back to `Blend` and publishes anyway**, as does one whose
  manifest says it was trained through a date more than 14 days old — a trainer that has been dead
  for a fortnight should not keep serving, and 14 days is comfortably longer than the longest
  intentional pause (the collector is paused while the machine is gaming) and far shorter than a
  season. The site never stops updating because a model file is bad.
- `FORECASTERS` gains `("trained", Trained)`, which is what puts it in every table
  `evaluate-forecast.py` prints.

## 7. Evaluation

`evaluate.py` is per city as of `c19de14`, and everything here inherits that.

**The backtest refits on the same cadence production does.** Not once per origin — once per day
boundary, reused for that day's origins, which is exactly what ships. This is both cheaper (days, not
origins, many fits) and *more faithful*: a per-origin refit would score a model fresher than the one
users get, and would flatter it.

The leak guarantee is unchanged and easy to state: the model serving an origin in day `D` was
trained on data strictly before the boundary of day `D−1` (§5), so it is a full day clear of every
label it is scored on, not merely a second.

**The gate for shipping at all** — distinct from the nightly adoption gate — is the one Stage A
inherited from spec §8, on the hard subset, per horizon, per city:

- beats `Persistence` **and** `Climatology` on Brier at every horizon, and
- closes the mid-band calibration defect in §1 rather than moving it, and
- does not regress the 0.9–1.0 band, where 85% of the mass lives.

Failing any of those, `Blend` stays in the grid and the model stays in the table. A trained model
that does not beat the baseline is a finding, not a failure.

**Rollout is shadow-first.** The trained model publishes nothing until it has run alongside `Blend`
for a week of nightly refits with the adoption gate passing each night. Taipei first — it has the
deepest corpus by two weeks — and each further city when its own corpus clears the same bar.

## 8. Honesty

Unchanged and non-negotiable, restated because a model is the easiest place to break them:

- A null probability never renders as a number; `0` is a real reading.
- The ranker's expected-cost score is never shown.
- A stalled feed still says so — the model must not paper over a frozen lot with a plausible forecast.
- A `0` amenity count still differs from an absent one.
- No skill number is ever reported without its support alongside it.

## 9. Security and cost

### 9.1 Cost: nothing recurring, and one thing that could become a cost

- **LightGBM is MIT, numpy is BSD-3.** No licence cost, no account, no registration.
- **Training runs on hardware already owned and already running.** No hosted training, no GPU, no
  inference endpoint.
- **No external feature APIs.** This is why weather is excluded in §10 rather than merely deferred:
  every usable source is paid or rate-limited below six cities × 5 minutes, and this project takes no
  recurring cost.
- **The published artifacts do not change** — same `grid.bin` format, same size, same number of KV
  writes. Cloudflare Workers Free is unaffected; Stage B adds no bandwidth and no request volume.
- **The one resource that can grow into a bill is disk**, and the model files are negligible beside
  the corpus (a LightGBM text model is measured in MB). That is why measuring cold-store growth is a
  prerequisite, not because the models are large.

Net: **zero recurring cost**, and the only hardware is the laptop already collecting.

### 9.2 Dependency footprint (measured, 2026-09-21)

`docker-collector:latest` today holds `pyarrow 25.0.1`, `pyproj 3.8.0`, `requests`, `certifi`,
`charset-normalizer`, `idna`, `urllib3`. **`numpy` is not present** — pyarrow 25 dropped the
requirement.

So LightGBM via the native API costs `numpy` (~20 MB) + `lightgbm` (~1.5 MB) ≈ **22 MB**. For
comparison, scikit-learn's `HistGradientBoostingClassifier` would cost numpy + scipy + scikit-learn
≈ 90 MB, and XGBoost's wheel is larger still.

**Correcting an earlier draft of this section:** it said the new packages would be hash-pinned "as
the existing dependencies are". They are not. `pyproject.toml` declares version *ranges*
(`requests>=2.32`, `pyarrow>=17`, `pyproj>=3.6`) and the image installs with a plain `pip install .`,
so nothing here is hash-pinned today. Adding two more range-pinned packages does not change that
posture, and pinning only the two new ones would be security theatre — a supply-chain guarantee is
worth having across all six or not claimed at all. Introducing `--require-hashes` for the whole
dependency set is a reasonable separate change; this spec does not assume it.

Both packages are also needed by the **collector**, not only the trainer, because §6 runs inference
in-process at publish time. That is worth stating plainly: it puts a C++ extension in the process
that talks to six external feeds. The mitigations are the ones in §9.3 — the model is a text file,
never a pickle, and its digest is verified before it is loaded.

### 9.3 Security

**Never unpickle a model.** The model file is written by a background job and read by the collector,
which makes it the one artifact whose format is a code-execution decision. `pickle` and `joblib`
deserialise to arbitrary code and are forbidden here; LightGBM's own `save_model` / `Booster(model_file=…)`
text format is a plain dump with no executable content. This is a hard rule, not a preference, and a
test asserts the loader is never handed a pickle.

**The trainer is isolated and offline.**

- Its own compose service, with `network_mode: none` — training makes no network call, so it needs
  no egress, and denying it removes the entire class of exfiltration and supply-chain-at-runtime
  concerns.
- The corpus is mounted **read-only**. The trainer's only write access is `data/models/`.
- It receives neither the Cloudflare deploy key nor the upload secret. It has no reason to hold
  either, and the deploy pipeline's existing rule — third-party code never runs in a shell holding
  the deploy key — extends to it.
- Memory and wall-clock caps, so a runaway fit cannot starve the collector sharing the laptop.
  (The collector itself deliberately has no memory limit; the trainer is the component that could
  run away, so it is the one that gets bounded.)

**The model never leaves the machine.** Inference runs in the collector; only `grid.bin` is
published. No model artifact is uploaded to KV, and no training data — nor anything derived from it
beyond the published probabilities — leaves the laptop.

**Integrity on load.** The manifest carries a SHA-256 of the model file, and the collector verifies
it before loading. The atomic write-then-rename already prevents a half-written file being read; the
digest makes a corrupted or substituted one detectable rather than silently served. On mismatch the
collector falls back to `Blend` and publishes anyway (§6).

**No new inbound surface.** The trainer listens on nothing and exposes no port.

**Unchanged and still binding:** no `verify=False`, no `CERT_NONE`, no `check_hostname=False`
anywhere; credentials stay with the user and are never handled by tooling.

## 10. Risks

- **Frozen lots poison training.** Mitigated in §4.2 inside the trainer, where run detection is
  affordable. The separate, long-deferred question of frozen readings in `Counts` stays deferred and
  is not a Stage B dependency.
- **Nightly self-degradation.** Mitigated by §5. The gate is the load-bearing part of this design; if
  any part of the plan gets cut, it is not this one.
- **Nondeterminism silently invalidates the backtest.** Mitigated by the pinned config in §3.1 and a
  byte-identity test.
- **The corpus is thinner than it looks.** Six-city collection began 2026-09-17; at the time of
  writing that is four days, and a 30-minute-of-week bucket is visited once a week. Taipei (since
  ~09-04) is the only city with real depth. `scripts/corpus-coverage.py --city <city>` is the check,
  and it was only made per-city on 2026-09-21 — before that it reported the union of six cities and
  one feed's healthy night filled in another's outage.
- ~~**Disk is still unmeasured.**~~ **Measured 2026-09-21**: 65.4 MB/month projected, ~0.78 GB/year,
  against the nationwide spec's 150–400 MB/month — about a third of the low end. **Disk does not
  block Stage B.** The hot store is a separate, permanent ~312 MB floor, bounded by the 48-hour
  window and not growing with the corpus. Model files are negligible beside either.

- **Historical lot metadata exists for Taipei only.** `snapshot_metadata` is called once, on
  `config.METADATA_URL`, so `cold/meta/` dates Taipei's roster per day; the other five cities carry
  their rosters in the tick and never write them dated. For those five, a training row from three
  weeks ago can only be joined against *today's* `capacity_car`, `lot_type` and `area` — a mild
  look-ahead, since capacity moves rarely, but a real one, and a lot that has since left the feed has
  no metadata at all. §7 ships Taipei first, where the history exists, so this constrains the *rollout
  order* rather than the design. Extending to another city requires dating its roster first, which is
  the same change as compressing the snapshots (they are 89% of the cold store and near-identical day
  to day).
- **`ts_kind` is not persisted.** `feed.py` says a fetch-time stamp "is an assumption, not a reading,
  and a backtest must be able to exclude it" — but nothing records which is which. Kaohsiung and
  Taoyuan are inferable from the city; Tainan, New Taipei and Hsinchu fall back to fetch time **per
  record** (`tainan.py:105` and its counterparts), so for those three it is unrecoverable afterwards.

  **No schema change is needed.** `Q` in `quality.py` is a per-observation `IntFlag` "written at
  insert time", already persisted in both stores — an `INTEGER` column in the hot store and a
  per-slot `int16` list in Parquet. Bits 1/2/4 are used and 8 is reserved for `FROZEN`; **16 is
  free**. So this is one new flag, one `|=` in `insert_snapshot`, and tests — not a migration of
  either store, and every existing reader keeps working.

  It remains time-sensitive for the reason a column would be: the bit is only meaningful for rows
  written after it ships, so the corpus divides into "before, provenance unknown" and "after, known".
  The sooner it lands, the smaller the unknown half.
- **Weather is the obvious missing feature** and is deliberately excluded: every source is either paid
  or rate-limited beyond what six cities × 5 minutes needs, and this project takes no recurring cost.

## 11. Out of scope

- Any change to `rank.ts`, the preferences, or the UI.
- Predicting anything other than `P(free_car >= 1)` — no expected-count, no distribution.
- Per-horizon models (§3.2).
- Online learning (§4.1).
- Training for cities whose corpus has not cleared the §7 bar.
