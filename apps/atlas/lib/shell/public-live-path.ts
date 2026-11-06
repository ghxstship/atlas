/**
 * The public, no-account pages the root layout treats apart (ADR 0130, ADR 0142). They set only the strictly necessary
 * grant cookie, so they load no product analytics, even for a visitor who consented elsewhere on the site.
 */
export function isPublicLivePath(path: string): boolean {
  return /^\/share\/(view|screen|showcaller)\//.test(path);
}

/**
 * Pages that keep the cookie banner off, so it never covers what runs there: a display screen's timer on a TV, and a
 * showcaller's console and pop-out clock in the middle of a show.
 */
export function hidesCookieBanner(path: string): boolean {
  return path.startsWith("/share/screen/") || path.startsWith("/share/showcaller/");
}
