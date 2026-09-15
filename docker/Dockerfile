FROM python:3.13-slim

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
