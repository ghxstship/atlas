/**
 * Theme selection. The console defaults to System (Section 11.6), as Gateway: it follows the
 * operating system between Dark and Light. A person's explicit choice is kept in the `xos-theme`
 * cookie so the server renders it with no flash. For System the server reads the
 * `Sec-CH-Prefers-Color-Scheme` client hint when the browser sends it, and the client follows
 * operating system changes after hydration.
 */
export const THEME_COOKIE = "xos-theme";
export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Theme = "dark" | "light";

export function preferenceFromCookie(value: string | undefined): ThemePreference {
  return value === "dark" || value === "light" ? value : "system";
}

/** The theme to render: an explicit choice, else the client hint, else Light. */
export function renderedTheme(preference: ThemePreference, hint: string | null): Theme {
  if (preference !== "system") return preference;
  return hint === "dark" ? "dark" : "light";
}
