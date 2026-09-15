/**
 * Placeholder cards for the ranked list while the two artifacts are still
 * downloading -- shimmering blanks that hold the list's shape rather than a
 * spinner that collapses it, so the layout does not jump once real rows
 * arrive. `aria-hidden`: a screen reader has nothing to read here yet, and
 * `App`'s own `loading` string (see `i18n.ts`) already says so.
 */
export function Skeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton-card" />)}
    </div>
  );
}
