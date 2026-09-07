/**
 * "I am going to 台北車站." The third way to set a destination, and the first
 * one that answers the question a driver actually asks.
 *
 * The other two are a GPS fix ("where am I", which is the wrong question for
 * someone on their way somewhere else) and a tap on the map (which needs the
 * user to already know where the place is on a map). This one takes a name.
 *
 * It searches the roster the app is already holding -- see `search.ts` for why
 * there is no geocoder behind it, and for the 臺/台 fold that makes half the
 * roster reachable. Everything here is presentational: the component owns the
 * query and which option is highlighted, and hands the chosen `Lot` straight
 * back. Where a destination *goes* is `App`'s business, and there is exactly one
 * path for that.
 *
 * The accessibility is the ARIA 1.2 combobox pattern rather than a div that
 * looks like one: a real `<label>`, `role="combobox"` with `aria-expanded` on
 * the input, `role="listbox"`/`role="option"`, and `aria-activedescendant` so
 * the highlighted option is announced while focus stays in the text field.
 * Keyboard alone completes the task: type, up/down, enter, escape.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { districtName, fillTemplate, t, type Lang } from "../i18n";
import { searchLots } from "../search";
import type { Lot } from "../types";

export interface DestinationSearchProps {
  /** The roster to search. Every lot, unranked -- this runs before a destination exists. */
  lots: readonly Lot[];
  /** The chosen car park. The caller turns it into a destination. */
  onSelect: (lot: Lot) => void;
  lang: Lang;
}

export function DestinationSearch({ lots, onSelect, lang }: DestinationSearchProps) {
  const s = t(lang);
  // Generated, not hardcoded: a colliding id silently points the label, the
  // listbox and `aria-activedescendant` at whatever else claimed it first.
  const id = useId();
  const listId = `${id}-results`;
  const hintId = `${id}-hint`;
  const optionId = (position: number) => `${id}-option-${position}`;

  const [query, setQuery] = useState("");
  /** Which option Enter would take. Reset to the top whenever the query moves. */
  const [active, setActive] = useState(0);
  /** Escape, and a completed choice, close the popup without clearing the box. */
  const [dismissed, setDismissed] = useState(false);

  const results = useMemo(() => searchLots(lots, query), [lots, query]);

  const hasQuery = query.trim() !== "";
  const open = hasQuery && !dismissed && results.length > 0;
  const noMatch = hasQuery && !dismissed && results.length === 0;

  // Keep the highlighted option on screen when the keyboard walks past the
  // bottom of a popup that scrolls. jsdom has no `scrollIntoView`, hence the
  // optional call rather than a feature test.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);

  function choose(lot: Lot) {
    // The feed's own spelling, not the folded search key: this is the name on
    // the sign the driver is about to look for.
    setQuery(lot.n);
    setDismissed(true);
    onSelect(lot);
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
      if (event.key === "ArrowDown" && hasQuery && results.length > 0) {
        event.preventDefault();
        setDismissed(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((position) => (position + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((position) => (position + results.length - 1) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[active];
      if (chosen !== undefined) choose(chosen);
    }
  }

  return (
    <div
      className="search"
      onBlur={(event) => {
        // Only a focus move that leaves the whole control closes it, so a click
        // on an option is not a dismissal of the list it was clicked in.
        if (!event.currentTarget.contains(event.relatedTarget)) setDismissed(true);
      }}
    >
      <label className="search-label" htmlFor={id}>
        {s.searchLabel}
      </label>
      <div className="search-field">
        <input
          id={id}
          type="search"
          role="combobox"
          className="search-input"
          value={query}
          placeholder={s.searchPlaceholder}
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-activedescendant={open ? optionId(active) : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
        />
        {/* Present in the tree whether or not it has options, so the
            `aria-controls` on the combobox always resolves. */}
        <ul
          id={listId}
          role="listbox"
          aria-label={s.searchResultsLabel}
          className="search-results"
          hidden={!open}
          data-testid="search-results"
        >
          {open &&
            results.map((lot, position) => (
              <li
                key={lot.id}
                id={optionId(position)}
                role="option"
                aria-selected={position === active}
                className="search-option"
                data-testid="search-option"
                data-lot-id={lot.id}
                // Mouse-down would blur the input and close the list before the
                // click ever landed on the option that is being clicked.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(position)}
                onClick={() => choose(lot)}
              >
                {/* Chinese, always: the name has to match the signage. */}
                <span className="search-option-name">{lot.n}</span>
                <span className="search-option-where">{districtName(lot.a, lang)}</span>
              </li>
            ))}
        </ul>
      </div>

      {/* What this can and cannot find. `市政府` matches nothing, and a search
          box that does not say what it searches earns the confusion. */}
      <p className="search-hint" id={hintId}>
        {s.searchHint}
      </p>

      {noMatch && (
        <p className="search-empty" role="status" data-testid="search-no-match">
          {s.searchNoMatch}
        </p>
      )}
      {open && (
        <p className="visually-hidden" role="status">
          {fillTemplate(s.searchResultsTemplate, { n: results.length })}
        </p>
      )}
    </div>
  );
}
