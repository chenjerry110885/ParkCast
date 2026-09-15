/**
 * The one hook that decides desktop layout vs. phone layout.
 *
 * `App.tsx` picks between a bottom sheet and a side panel by asking this
 * hook, not by reading `window.innerWidth` on every render -- a media query
 * is the platform's own idea of the breakpoint, it updates on resize without
 * a listener this module has to debounce, and it degrades to `false` (phone
 * layout) rather than throwing when `matchMedia` is missing, which is the
 * case in SSR and in every test that does not stub it.
 */
import { useEffect, useState } from "react";

export const DESKTOP_QUERY = "(min-width: 768px)";

function matches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (event: { matches: boolean }) => setValue(event.matches);
    // Resyncs state with the live matchMedia result for the new `query`: the useState initialiser above only captured it once, at mount.
    // oxlint-disable-next-line react/set-state-in-effect
    setValue(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return value;
}
