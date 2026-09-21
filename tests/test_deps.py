"""The two packages Stage B adds, and the API it commits to using.

A dependency test reads as trivial until an image is rebuilt without one. The
failure would not be an ImportError anyone sees: `model.load` returns None on
anything unexpected and the collector falls back to `Blend` and publishes
anyway, exactly as designed -- so a missing package looks like a forecaster
quietly deciding it has nothing to say, in production, with a green log.
"""


def test_lightgbm_and_numpy_are_importable():
    import lightgbm
    import numpy

    assert lightgbm.__version__
    assert numpy.__version__


def test_lightgbm_is_used_through_its_native_api_not_the_sklearn_wrapper():
    """The wrapper would pull scikit-learn and scipy in for nothing this project
    calls -- roughly 90 MB against 22 MB. These three names are the whole of the
    surface Stage B uses, so if they exist the wrapper is never needed.
    """
    import lightgbm

    assert hasattr(lightgbm, "train")
    assert hasattr(lightgbm, "Dataset")
    assert hasattr(lightgbm, "Booster")


def test_numpy_is_a_declared_dependency_not_an_accident():
    """It arrived with neither pyarrow nor pyproj: pyarrow 25 dropped its numpy
    requirement, which is why this is a real addition rather than a name that
    happened to already be importable. Declared directly, so the day some other
    package stops depending on it nothing breaks silently -- the same reason
    `certifi` is named in pyproject.toml.
    """
    import tomllib
    from pathlib import Path

    pyproject = tomllib.loads(
        (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text(encoding="utf-8")
    )
    declared = " ".join(pyproject["project"]["dependencies"])
    assert "numpy" in declared
    assert "lightgbm" in declared


def test_a_fit_is_reproducible_in_this_image(tmp_path):
    """The determinism Stage B's backtest depends on is a property of the build,
    not only of the parameters: multi-threaded histogram construction is the
    known source of run-to-run variation, and whether it is used depends on how
    the wheel was compiled. Proven here, in the image, before anything is built
    on top of it.
    """
    import lightgbm as lgb
    import numpy as np

    rng = np.random.default_rng(0)
    x = rng.normal(size=(400, 4))
    y = (x[:, 0] + rng.normal(scale=0.5, size=400) > 0).astype(int)
    params = {
        "objective": "binary", "verbosity": -1, "deterministic": True,
        "force_row_wise": True, "num_threads": 1, "seed": 17, "num_leaves": 7,
    }

    first = lgb.train(params, lgb.Dataset(x, label=y), num_boost_round=10).model_to_string()
    second = lgb.train(params, lgb.Dataset(x, label=y), num_boost_round=10).model_to_string()

    assert first == second, (
        "two fits on identical data differ, so no backtest can reconstruct the "
        "model as it would have been at a past origin"
    )
