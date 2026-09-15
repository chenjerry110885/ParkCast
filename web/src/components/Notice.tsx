/**
 * A single-line banner for the things the app needs to say outside the
 * ranked list itself -- a load failure, a too-old forecast, a coverage
 * warning -- toned rather than styled per call site, so `forecastTooOld` and
 * `loadFailed` and a future caller all look like the same kind of statement
 * instead of each inventing its own colour. `tone` picks the accent
 * (`notice--info|warn|error`); `role` and `testId` are left to the caller,
 * since only they know whether a given notice is decorative or needs
 * `role="alert"` to be announced.
 */
import type { ReactNode } from "react";

interface Props { tone?: "info" | "warn" | "error"; role?: string; testId?: string; children: ReactNode }

export function Notice({ tone = "info", role, testId, children }: Props) {
  return (
    <p className={`notice notice--${tone} anim-slide-down`} role={role} data-testid={testId}>{children}</p>
  );
}
