/**
 * Theme selection. Dark is the default (Section 11.1); a person's choice is kept in the
 * `xos-theme` cookie so the server renders the right theme with no flash and no inline script.
 * Personal preferences (Section 4.5.6, A30) become the source once their table lands.
 */
export const THEME_COOKIE = "xos-theme";
export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export function themeFromCookie(value: string | undefined): Theme {
  return value === "light" ? "light" : "dark";
}
