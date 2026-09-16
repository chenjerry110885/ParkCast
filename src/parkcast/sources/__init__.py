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


SOURCES: dict[str, Source] = {}
