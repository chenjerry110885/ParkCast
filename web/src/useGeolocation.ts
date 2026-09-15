/**
 * The device-geolocation state machine, extracted from `App.tsx` so the
 * bottom sheet, side panel and top bar can all read `geo` without threading
 * `requestLocation`'s internals through props. The behaviour is unchanged
 * from what shipped there -- see the comments below, carried over with it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLon } from "./geo";

export type GeoState = "idle" | "locating" | "ready" | "unavailable";
export const GEO_TIMEOUT_MS = 10_000;
export const GEO_WATCHDOG_MS = 12_000;

export function useGeolocation(onFix: (at: LatLon) => void) {
  const [geo, setGeo] = useState<GeoState>("idle");
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abandonRef = useRef<(() => void) | null>(null);
  const onFixRef = useRef(onFix);
  useEffect(() => { onFixRef.current = onFix; }, [onFix]);
  useEffect(() => () => { if (watchdog.current !== null) clearTimeout(watchdog.current); }, []);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { setGeo("unavailable"); return; }
    setGeo("locating");

    // Whichever of the three finishes first wins, once: the success callback,
    // the error callback, or the watchdog that covers the prompt that answers
    // neither. Without the third, "定位中…" is a permanent state.
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (watchdog.current !== null) clearTimeout(watchdog.current);
      watchdog.current = null;
      abandonRef.current = null;
      finish();
    };
    watchdog.current = setTimeout(() => settle(() => setGeo("unavailable")), GEO_WATCHDOG_MS);
    // A fourth way to finish: the user answered the question themselves.
    abandonRef.current = () => settle(() => setGeo("idle"));

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => settle(() => { onFixRef.current({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setGeo("ready"); }),
        // Denied, timed out, or position unavailable: one visible end state.
        () => settle(() => setGeo("unavailable")),
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch {
      settle(() => setGeo("unavailable"));
    }
  }, []);

  // Whatever the pending location request was about to say, it is answering a
  // question the caller has now answered better -- and a position that landed
  // a second later would silently override that better answer.
  const abandon = useCallback(() => { abandonRef.current?.(); }, []);
  // A failure the user has routed around is no longer worth reporting.
  const clearFailure = useCallback(() => { setGeo((g) => (g === "unavailable" ? "idle" : g)); }, []);
  return { geo, request, abandon, clearFailure };
}
