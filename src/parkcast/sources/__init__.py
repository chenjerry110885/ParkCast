"""Per-city source adapters: one shared protocol over one shared transport.

Each city module (`sources.taipei`, `sources.newtaipei`, ...) exposes a
`Source` implementing `fetch`, plus a pure `parse` the adapter's own tests
call directly. `SOURCES` is populated as each adapter lands.
"""
import os
from dataclasses import dataclass
from typing import Protocol

from parkcast.feed import FeedSnapshot
from parkcast.metadata import Lot


@dataclass(frozen=True, slots=True)
class SourceTick:
    snapshot: FeedSnapshot
    # The roster this tick carried, or None when the city publishes its metadata
    # separately (Taipei). Five of six feeds answer both questions in one
    # request, and fetching twice would double the load for no new fact.
    lots: tuple[Lot, ...] | None


class Source(Protocol):
    city: str

    def fetch(self, *, now: int) -> SourceTick: ...


# Imported down here, after `SourceTick`/`Source` are defined: every adapter
# does `from parkcast.sources import SourceTick, http` (some also `geo`) at
# its own module level, and importing them from inside this package's own
# __init__ only works once those names already exist as attributes on this
# (still-initialising) module.
from parkcast.sources import (  # noqa: E402
    hsinchu, kaohsiung, newtaipei, taipei, tainan, taoyuan,
)

SOURCES: dict[str, Source] = {s.city: s for s in (
    taipei.Source(), newtaipei.Source(), kaohsiung.Source(),
    tainan.Source(), taoyuan.Source(), hsinchu.Source(),
)}

# Which of `SOURCES` this container actually collects. Unset means all of them,
# so an operator who sets nothing gets the registry exactly as it reads above.
CITIES_ENV = "PARKCAST_CITIES"


def select(names: str | None) -> list[Source]:
    """The sources named in a comma-separated `names`, in `SOURCES` order.

    `None`, empty or whitespace means every source: the default has to be the
    whole registry, or an operator who has never heard of this variable would
    silently stop collecting five cities on the next deploy.

    Spec section 9 stages the rollout -- Taipei alone, then New Taipei, then
    the rest, one per tick-cycle, watching per-source health -- and until this
    existed that meant editing `SOURCES` and rebuilding the image between each
    step. It also means a first boot after a merge does not turn six feeds on
    at once, which is when an unproven adapter costs the most.

    UNKNOWN NAMES RAISE. Quietly ignoring one would collect a set the operator
    did not ask for while they believed otherwise, and the missing city's
    history cannot be backfilled later -- the same reason a typo is worth
    failing a boot over. The message names both the typo and every valid
    choice, because the person reading it is mid-rollout at a terminal.

    Order and duplicates are taken from `SOURCES`, not from the string: the
    registry's order is the request order within a tick, and `PARKCAST_CITIES`
    is a set of cities to enable, not an instruction about sequencing.
    """
    if names is None or not names.strip():
        return list(SOURCES.values())
    wanted = [name.strip() for name in names.split(",") if name.strip()]
    unknown = sorted({name for name in wanted if name not in SOURCES})
    if unknown:
        raise ValueError(
            f"{CITIES_ENV} names {', '.join(unknown)}, which is not a city this "
            f"collector has an adapter for. Valid names: {', '.join(SOURCES)}. "
            f"Unset {CITIES_ENV} to collect all {len(SOURCES)}."
        )
    chosen = set(wanted)
    return [source for city, source in SOURCES.items() if city in chosen]


def from_environment() -> list[Source]:
    """`select` over `CITIES_ENV`. Raises ValueError on an unknown name."""
    return select(os.environ.get(CITIES_ENV))
