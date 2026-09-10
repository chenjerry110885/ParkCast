"""Check a copied corpus against the manifest written before it was moved.

`data/` is the only thing in this project that cannot be rebuilt, and the ways
it goes wrong in transit are quiet ones: a truncated Parquet file still opens, a
`hot.sqlite` copied without its write-ahead log still passes `PRAGMA
quick_check`, and a partial USB copy still leaves a directory that looks right.
Coverage numbers would not catch any of those -- a corpus missing one day looks
exactly like a corpus that never collected that day.

A hash per file catches all of them, and hashing 40 MB takes about a second.

    python scripts/verify-corpus.py                     # data-manifest.txt beside data/
    python scripts/verify-corpus.py --manifest path/to/data-manifest.txt

Exit status is 0 only when every file in the manifest is present and identical.
Extra files are reported but do not fail the run: the collector writes new
artifacts within five minutes of starting, so on a machine that has already
begun collecting, extras are expected and absences are not.

See `docs/collector-move.md` for where the manifest comes from.
"""
import argparse
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 1 << 20


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def parse(manifest: Path) -> list[tuple[str, int, str]]:
    """`<sha256>  <size>  <relative path>`, ignoring comments and blank lines."""
    entries = []
    for number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        if len(parts) != 3:
            raise SystemExit(f"{manifest}:{number}: cannot parse -- {line!r}")
        digest, size, rel = parts
        entries.append((digest, int(size), rel))
    if not entries:
        raise SystemExit(f"{manifest}: no entries")
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=None,
                        help="manifest to check (default: data-manifest.txt beside data/)")
    parser.add_argument("--root", default=str(ROOT),
                        help="directory the manifest's paths are relative to")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    manifest = Path(args.manifest) if args.manifest else root / "data-manifest.txt"
    if not manifest.exists():
        raise SystemExit(
            f"no manifest at {manifest}\n"
            f"It is written on the source machine before the copy -- see docs/collector-move.md."
        )

    entries = parse(manifest)
    missing, wrong_size, corrupt, ok = [], [], [], 0

    for digest, size, rel in entries:
        path = root / rel
        if not path.exists():
            missing.append(rel)
        elif path.stat().st_size != size:
            wrong_size.append((rel, size, path.stat().st_size))
        elif sha256(path) != digest:
            corrupt.append(rel)
        else:
            ok += 1

    listed = {rel for _, _, rel in entries}
    present = {p.relative_to(root).as_posix() for p in (root / "data").rglob("*") if p.is_file()}
    extra = sorted(present - listed)

    print(f"manifest : {manifest}")
    print(f"root     : {root}")
    print(f"verified : {ok} of {len(entries)} files identical\n")

    for rel in missing:
        print(f"  MISSING      {rel}")
    for rel, want, got in wrong_size:
        print(f"  WRONG SIZE   {rel}  expected {want:,}, found {got:,}")
    for rel in corrupt:
        print(f"  CORRUPT      {rel}  (right size, different contents)")
    for rel in extra:
        print(f"  extra        {rel}  (not in the manifest -- fine if collection has started)")

    failed = len(missing) + len(wrong_size) + len(corrupt)
    if failed:
        print(f"\n{failed} problem(s). Do NOT start the collector over this copy: "
              f"re-copy from the source, which must still be intact.")
        return 1
    print("\nEvery file in the manifest is present and byte-identical. Safe to start the collector.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
