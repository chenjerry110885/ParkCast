"""Create the collector's upload secret file. Never prints the value.

    python scripts/new-upload-secret.py            # docker/secrets/parkcast_upload_secret
    python scripts/new-upload-secret.py --force    # rotate an existing one

The file holds exactly the secret -- no newline, no BOM -- so the same bytes can
be fed to `wrangler secret put` with a shell redirect (docs/deploy.md).
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from parkcast.upload import SECRET_RE, new_secret  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path,
                        default=ROOT / "docker" / "secrets" / "parkcast_upload_secret")
    parser.add_argument("--force", action="store_true", help="replace an existing secret")
    args = parser.parse_args()
    if args.out.exists() and not args.force:
        print(f"{args.out} already exists; pass --force to rotate it", file=sys.stderr)
        return 1
    value = new_secret()
    if not SECRET_RE.fullmatch(value):
        print("generated value has the wrong shape; nothing written", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(value.encode("ascii"))
    print(f"wrote a new upload secret to {args.out} ({len(value)} characters, not shown)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
