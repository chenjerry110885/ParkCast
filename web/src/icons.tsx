/**
 * The app's icon set: sixteen inline SVGs, one stroke drawing each on a
 * 24-box, `currentColor` so they pick up whatever colour the surrounding
 * text has rather than carrying their own. Inline rather than a sprite or an
 * icon-font import -- no new dependency, and no request the offline shell
 * has to cache separately from the JS that draws the rest of the screen.
 *
 * Decorative by default (`aria-hidden`): most uses sit next to a text label
 * that already says what the icon means, and a screen reader announcing
 * both is noise. Pass `label` on the rare icon that stands alone -- a
 * button with no visible text -- and it becomes the accessible name instead
 * (`role="img"` + `aria-label`), never both at once.
 */
import type { SVGProps } from "react";

export interface IconProps { size?: number; className?: string; label?: string }

function Icon({ size = 20, className, label, children }: IconProps & { children: SVGProps<SVGSVGElement>["children"] }) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} {...a11y}>
      {children}
    </svg>
  );
}

export const Search = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
export const Locate = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></Icon>;
export const Walk = (p: IconProps) => <Icon {...p}><circle cx="13" cy="4" r="2" /><path d="m8 22 3-8-3-2 1-5 4-1 3 4 3 1M11 14l3 3v5" /></Icon>;
export const Price = (p: IconProps) => <Icon {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M7 12h.01M17 12h.01" /></Icon>;
export const Spaces = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /></Icon>;
export const Clock = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const Pin = (p: IconProps) => <Icon {...p}><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" /><circle cx="12" cy="10" r="2.5" /></Icon>;
export const Station = (p: IconProps) => <Icon {...p}><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 17l-2 4M15 17l2 4M9 7h6" /></Icon>;
export const Landmark = (p: IconProps) => <Icon {...p}><path d="M3 21h18M5 21V10M19 21V10M9 21v-7h6v7M12 3l9 6H3l9-6Z" /></Icon>;
export const Street = (p: IconProps) => <Icon {...p}><path d="M4 21 9 3M20 21 15 3M12 6v2M12 11v2M12 16v2" /></Icon>;
export const Area = (p: IconProps) => <Icon {...p}><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7ZM9 4v13M15 7v13" /></Icon>;
export const CarPark = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 17V7h4a3 3 0 0 1 0 6H9" /></Icon>;
export const Info = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v5h1" /></Icon>;
export const Chevron = (p: IconProps) => <Icon {...p}><path d="m6 15 6-6 6 6" /></Icon>;
export const Globe = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>;
export const Cross = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
