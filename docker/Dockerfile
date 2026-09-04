FROM python:3.13-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1
# No VOLUME declaration: compose already bind-mounts ../data, and under a plain
# `docker run` a VOLUME silently creates an anonymous volume that `docker rm`
# then orphans -- the operator loses the corpus without ever being told.
CMD ["python", "-m", "parkcast"]
