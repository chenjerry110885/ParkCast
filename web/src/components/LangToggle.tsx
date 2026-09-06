import type { Lang } from "../i18n";

interface LangToggleProps {
  lang: Lang;
  onChange: (lang: Lang) => void;
}

/**
 * A two-state switch between English and Traditional Chinese.
 *
 * Presentational only -- the caller owns where `lang` lives (React state, a
 * URL param, `localStorage`) and how it reaches `t()`. The button always
 * shows the *other* language's own name, so tapping it reads as "switch to
 * this" rather than announcing the language currently shown.
 */
export function LangToggle({ lang, onChange }: LangToggleProps) {
  const other: Lang = lang === "en" ? "zh" : "en";
  return (
    <button
      type="button"
      onClick={() => onChange(other)}
      aria-label={lang === "en" ? "切換為中文" : "Switch to English"}
    >
      {other === "zh" ? "中文" : "English"}
    </button>
  );
}
