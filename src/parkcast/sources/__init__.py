"""Per-city source adapters: one shared protocol over one shared transport.

Each city module (`sources.taipei`, `sources.newtaipei`, ...) exposes a
`Source` implementing `fetch`, plus a pure `parse` the adapter's own tests
call directly. `SOURCES` is populated as each adapter lands.
"""
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
