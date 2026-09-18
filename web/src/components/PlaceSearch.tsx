/**
 * "I am going to 台北車站" -- or 市政府, or 忠孝東路四段216巷, or 西門町. The
 * third way to set a destination, and the first one that answers the
 * question a driver actually asks.
 *
 * The other two are a GPS fix ("where am I", the wrong question for someone
 * on their way somewhere else) and a tap on the map (which needs the user to
 * already know where the place is on a map). This one takes a name -- and,
 * unlike the car-park-only box it replaces, a name for *anything* a driver
 * might say out loud: a landmark, an MRT station, a street down to the lane,
 * or a neighbourhood, not just the roster's own ~1,075 car park names. See
 * `../places` for why that gap existed and how `searchPlaces` closes it by
 * merging the live roster with an offline place index built once, ahead of
 * time, from the same basemap tiles the map already ships.
 *
 * Everything here is presentational: the component owns the query, which
 * option is highlighted, and the on-device recent list; it hands the chosen
 * `Place` straight back. Where a destination *goes* is the caller's business.
 *
 * The accessibility is the ARIA 1.2 combobox pattern rather than a div that
 * looks like one: a real `<label>`, `role="combobox"` with `aria-expanded` on
 * the input, `role="listbox"`/`role="group"`/`role="option"`, and
 * `aria-activedescendant` so the highlighted option is announced while focus
 * stays in the text field.
 * Keyboard alone completes the task: type, up/down, enter, escape.
 *
 * Two things this version adds on top of that pattern: results are grouped
 * by kind (car parks first, then stations, landmarks, streets, areas -- the
 * same ordering `searchPlaces` already ranks by, so the grouping never
 * contradicts the order), and an empty box shows the on-device recent list
 * instead of nothing. Nothing about either leaves the phone: the index fetch
 * happens once, lazily, on the box's first focus rather than at page load
 * (a driver who never taps the search box never pays for it), and recent
 * picks live in `localStorage` alone -- see `../places` for the read/write/
 * clear helpers and their failure handling.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Area, CarPark, Cross, Landmark, Search, Station, Street } from "../icons";
import { districtName, fillTemplate, t, type Lang } from "../i18n";
import { clearRecent, loadPlaceIndex, lotsAsPlaces, pushRecent, readRecent, searchPlaces, type Place, type PlaceKind } from "../places";
import type { Lot } from "../types";

export interface PlaceSearchProps {
  /** The live roster, searched immediately -- see `lotsAsPlaces`. */
  lots: readonly Lot[];
  /** Where the offline place index lives. Fetched once, on first focus. */
  indexUrl: string;
  /** The chosen place. The caller turns it into a destination. */
  onSelect: (place: Place) => void;
  lang: Lang;
  /** Where recent picks are kept. Defaults to `window.localStorage`, guarded; pass `null` to disable recents (e.g. in a test with no storage). */
  storage?: Storage | null;
}

const ICONS: Record<PlaceKind, (p: { className?: string }) => JSX.Element> = { carpark: CarPark, station: Station, landmark: Landmark, street: Street, area: Area };

/**
 * What is shown beside a place's name to tell two of the same name apart.
 *
 * A car park's qualifier is its `area` -- one of the feed's twelve district
 * names, a closed set this app translates everywhere else it shows one (see
 * `i18n.ts`), so it is translated here too: an English reader picking between
 * two 市民停車場 should read "Beitou District", exactly as the ranked card
 * beneath already says. Everything else keeps its own spelling: the index's
 * qualifiers are nearest-locality names off the basemap, an open set with no
 * English to fall back to, and the English name when there is one is already
 * the right answer.
 *
 * The *name* is never touched either way -- it is what the sign says.
 */
function where(place: Place, lang: Lang): string {
  if (place.kind === "carpark") return place.qualifier === "" ? "" : districtName(place.qualifier, lang);
  return place.qualifier || place.en;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function PlaceSearch({ lots, indexUrl, onSelect, lang, storage }: PlaceSearchProps) {
  const s = t(lang);
  // Generated, not hardcoded: a colliding id silently points the label, the
  // listbox and `aria-activedescendant` at whatever else claimed it first.
  const id = useId();
  const listId = `${id}-results`;
  const hintId = `${id}-hint`;
  const optionId = (position: number) => `${id}-option-${position}`;
  /** The heading a `role="group"` points `aria-labelledby` at -- one per group key. */
  const groupHeadingId = (key: string) => `${id}-group-${key}`;
  const store = storage === undefined ? defaultStorage() : storage;
  /** The whole control, for the outside-press check below -- not just the input. */
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  /** Which option Enter would take. Reset to the top whenever the query moves. */
  const [active, setActive] = useState(0);
  /** Escape, and a completed choice, close the popup without clearing the box. */
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  /** `null` until the index has loaded (or failed); the roster searches on its own until then. */
  const [index, setIndex] = useState<Place[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<Place[]>(() => readRecent(store));

  const roster = useMemo(() => lotsAsPlaces(lots), [lots]);
  const all = useMemo(() => (index ? [...roster, ...index] : roster), [roster, index]);
  const groupName: Record<PlaceKind, string> = { carpark: s.groupCarParks, station: s.groupStations, landmark: s.groupLandmarks, street: s.groupStreets, area: s.groupAreas };

  // The index is fetched on the first focus, never at page load -- most
  // sessions of this app never open the search box at all, and paying for a
  // fetch they never asked for would be a worse offline story, not a better
  // one.
  useEffect(() => {
    if (!focused || index !== null || loading) return;
    setLoading(true);
    let cancelled = false;
    loadPlaceIndex(indexUrl).then((rows) => {
      if (cancelled) return;
      // `loadPlaceIndex` resolves `[]` both for a genuinely empty index and for a failed
      // fetch/parse (see its own doc comment) -- there is no way to tell those apart from
      // here. Treating an empty result as "not loaded yet" rather than committing it to
      // `index` keeps the roster-only fallback working, and -- because a failed attempt
      // also drops itself from `loadPlaceIndex`'s cache -- lets the next focus retry the
      // fetch instead of remembering the failure forever.
      if (rows.length > 0) setIndex(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      // ...and `loading` goes with it. Without this, a box that blurs mid-fetch
      // leaves the flag stuck `true` -- the `.then` above returns at `cancelled`
      // before ever clearing it -- and the guard at the top of this effect then
      // refuses every later retry for the rest of the session.
      setLoading(false);
    };
    // `index` and `loading` are set BY this effect; listing them would rerun it on its own state
    // change, calling the cleanup above and cancelling the fetch's own callback before the
    // response ever arrives.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, indexUrl]);

  const hasQuery = query.trim() !== "";
  const results = useMemo(() => searchPlaces(all, query), [all, query]);
  const showRecent = focused && !hasQuery && !dismissed && recent.length > 0;
  const options = showRecent ? recent : results;
  const open = !dismissed && (showRecent || (hasQuery && results.length > 0));
  const noMatch = hasQuery && !dismissed && results.length === 0 && !loading;
  // `active` is only reset to 0 on the interactions that are expected to move it (typing,
  // focusing, clearing, choosing) -- but the option list itself can also change size on its
  // own (the index finishing a load, recents replacing results and vice versa), which none
  // of those resets sees. Clamping what's actually rendered, rather than trying to catch
  // every such transition, keeps `aria-activedescendant`/`aria-selected` pointing at a real,
  // current option even when one of those resets was missed.
  const safeActive = options.length === 0 ? 0 : Math.min(active, options.length - 1);

  /**
   * The options, cut into the runs the listbox renders as labelled groups.
   *
   * A run rather than a bucket per kind: `searchPlaces` already returns the
   * kinds in tier order, so consecutive rows of one kind *are* the group, and
   * building it this way cannot reorder what the ranking decided. `from` is the
   * run's first position in `options`, which is what keeps `optionId`,
   * `aria-activedescendant` and the arrow keys agreeing about which option is
   * which after the flat list became a nested one.
   */
  const groups: { key: string; label: string; places: Place[]; from: number }[] = [];
  if (showRecent) {
    groups.push({ key: "recent", label: s.recentSearches, places: [...options], from: 0 });
  } else {
    options.forEach((place, position) => {
      const run = groups.at(-1);
      if (run !== undefined && run.key === place.kind) run.places.push(place);
      else groups.push({ key: place.kind, label: groupName[place.kind], places: [place], from: position });
    });
  }

  // Keep the highlighted option on screen when the keyboard walks past the
  // bottom of a popup that scrolls. jsdom has no `scrollIntoView`, hence the
  // optional call rather than a feature test.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(safeActive))?.scrollIntoView?.({ block: "nearest" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- optionId is a stable closure over `id`, not state; adding it would re-run this on every render for no reason.
  }, [safeActive, open]);

  // Dismissal lives on a `pointerdown` outside the control, not on `blur`: the
  // desktop `onMouseDown={preventDefault}` guard on each option keeps a click
  // there from ever blurring the input, but touch has no such guard, and
  // dragging a finger to scroll the results list blurs the input anyway --
  // the list and its options are not focusable, so `relatedTarget` is `null`
  // and the container's own `onBlur` below cannot tell that apart from focus
  // actually leaving the control. The standard outside-press pattern sidesteps
  // the question entirely: it does not care whether or how focus moved, only
  // where the press landed, so a scroll that starts inside the list never
  // dismisses it. This deliberately does NOT `preventDefault` the `pointerdown`
  // -- doing that would cancel touch's default scrolling action, trading the
  // dismiss bug for the very scroll bug this exists to fix.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node | null)) {
        setDismissed(true);
        setFocused(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    // Removed on every dependency change, not just on unmount -- an `open`
    // that already flipped back to `false` (Escape, a selection) must not
    // leave this listening for the next press anywhere on the page.
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(place: Place) {
    // The index's or the roster's own spelling, not the folded search key:
    // this is the name on the sign the driver is about to look for.
    setQuery(place.name);
    setActive(0);
    setDismissed(true);
    setRecent(pushRecent(store, place));
    onSelect(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Ours, not the browser's: `input[type=search]` clears itself on Escape,
      // which would throw away a query the user is still editing.
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (!open) {
      // Down re-opens a popup Escape closed, without retyping anything.
      if (event.key === "ArrowDown" && options.length > 0) {
        event.preventDefault();
        setDismissed(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i + options.length - 1) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[safeActive];
      if (chosen) choose(chosen);
    }
  }

  return (
    <div
      ref={containerRef}
      className="search"
      onBlur={(e) => {
        // Only a genuine keyboard tab-away closes it here -- the outside-press
        // effect above handles pointer/touch dismissal already, and a blur
        // whose `relatedTarget` is `null` (the touch-scroll case, but also any
        // other focus loss with nothing to blame) is not evidence of that: it
        // takes a real element outside the control on the other end to prove
        // focus actually left, rather than merely being interrupted.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
          setDismissed(true);
          setFocused(false);
        }
      }}
    >
      <label className="visually-hidden" htmlFor={id}>
        {s.searchLabel}
      </label>
      <div className="search__field">
        <Search className="search__icon" />
        <input
          id={id}
          type="search"
          role="combobox"
          className="search__input glass"
          value={query}
          placeholder={s.searchPlaceholder}
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-activedescendant={open ? optionId(safeActive) : undefined}
          onFocus={() => {
            setFocused(true);
            setDismissed(false);
            setActive(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
        />
        {query !== "" && (
          <button
            type="button"
            className="search__clear"
            aria-label={s.clearSearch}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery("");
              setDismissed(false);
              setActive(0);
            }}
          >
            <Cross />
          </button>
        )}
        {/* Present in the tree whether or not it has options, so the
            `aria-controls` on the combobox always resolves. */}
        <ul id={listId} role="listbox" aria-label={showRecent ? s.recentSearches : s.searchResultsLabel} className="search__results glass anim-pop" hidden={!open} data-testid="search-results">
          {open &&
            groups.map((group) => (
              // A real `role="group"` named by its own heading, rather than a
              // heading row sitting among the options as a `presentation`
              // sibling: a listbox's children are supposed to be options or
              // groups of them, and this is the version a screen reader can
              // announce ("Stations, 3 items") instead of silently skipping.
              // The options stay direct children of it, and `<div>`s rather
              // than `<li>`s because an `<li>` inside an `<li>` is invalid
              // markup -- the roles, not the tags, are what carry the pattern.
              <li key={group.key} role="group" aria-labelledby={groupHeadingId(group.key)}>
                <div className="search__group">
                  <span id={groupHeadingId(group.key)}>{group.label}</span>
                  {group.key === "recent" && (
                    <button
                      type="button"
                      className="search__recent-clear"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        clearRecent(store);
                        setRecent([]);
                      }}
                    >
                      {s.clearRecent}
                    </button>
                  )}
                </div>
                {group.places.map((place, i) => {
                  const position = group.from + i;
                  const Icon = ICONS[place.kind];
                  return (
                    <div
                      key={`${place.kind}-${place.name}-${place.lat}-${place.lon}`}
                      id={optionId(position)}
                      role="option"
                      aria-selected={position === safeActive}
                      className="search__option"
                      data-testid="search-option"
                      data-kind={place.kind}
                      data-lot-id={place.lotId}
                      // Mouse-down would blur the input and close the list before
                      // the click ever landed on the option that is being clicked.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(position)}
                      onClick={() => choose(place)}
                    >
                      <span className="search__option-icon">
                        <Icon />
                      </span>
                      <span>
                        <span className="search__option-name" lang="zh-Hant">
                          {place.name}
                        </span>
                        {where(place, lang) !== "" && <span className="search__option-where"> · {where(place, lang)}</span>}
                      </span>
                    </div>
                  );
                })}
              </li>
            ))}
        </ul>
      </div>

      {/* What this can and cannot find. `門牌號碼` (a house number) matches
          nothing, and a search box that does not say what it searches earns
          every "it can't find anything" the limitation would otherwise get. */}
      <p className="search__hint" id={hintId}>
        {s.searchHint}
      </p>

      {loading && hasQuery && (
        <p className="search__hint" role="status">
          {s.loadingPlaces}
        </p>
      )}

      {noMatch && (
        <p className="search__empty" role="status" data-testid="search-no-match">
          {s.searchNoMatch}
        </p>
      )}
      {open && !showRecent && (
        <p className="visually-hidden" role="status">
          {fillTemplate(s.searchResultsTemplate, { n: results.length })}
        </p>
      )}
    </div>
  );
}
