/**
 * Theme switching by `data-theme` (ADR 0009): Dark is the default, Light is complete, Sunlight is the
 * Compass maximum-contrast theme, and System follows the operating system between Dark and Light.
 * The token build scopes every color variable to `[data-theme]`, so a switch needs no rebuild.
 */

export const themes = ["dark", "light", "sunlight"] as const;
export type Theme = (typeof themes)[number];
export type ThemePreference = Theme | "system";

export const themePreferences: readonly ThemePreference[] = [...themes, "system"];

export function isThemePreference(value: string): value is ThemePreference {
  return (themePreferences as readonly string[]).includes(value);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_QUERY).matches;
}

/** The theme a preference renders: System resolves to Dark or Light from the operating system. */
export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): Theme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/**
 * Applies a preference to an element (the document root by default) and, for System, follows
 * operating system changes until the returned cleanup runs.
 */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): () => void {
  root.dataset["theme"] = resolveTheme(preference);
  root.dataset["themePreference"] = preference;
  if (preference !== "system" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  const follow = (event: MediaQueryListEvent) => {
    root.dataset["theme"] = event.matches ? "dark" : "light";
  };
  query.addEventListener("change", follow);
  return () => query.removeEventListener("change", follow);
}
