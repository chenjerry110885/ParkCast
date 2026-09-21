FROM python:3.13-slim

# LightGBM's manylinux wheel links against the GNU OpenMP runtime, and
# python:3.13-slim does not ship it. Without this, `import lightgbm` dies inside
# ctypes with "libgomp.so.1: cannot open shared object file" -- not at pip
# install time, when it would be obvious, but at import, which for the collector
# means the Stage B forecaster silently falls back to Blend and publishes anyway.
# Installed ahead of the source copy so the layer caches independently of it.
#
# The threading it provides is deliberately unused: `train.PARAMS` pins
# num_threads=1, because multi-threaded histogram construction is the known
# source of run-to-run variation and the backtest has to reproduce a fit exactly.
# The library still has to load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# A fixed, unprivileged identity. Nothing in the image runs as root at runtime.
RUN groupadd --gid 10001 parkcast \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin parkcast

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
# No VOLUME declaration: compose already bind-mounts ../data, and under a plain
# `docker run` a VOLUME silently creates an anonymous volume that `docker rm`
# then orphans -- the operator loses the corpus without ever being told.
USER 10001:10001
CMD ["python", "-m", "parkcast"]
