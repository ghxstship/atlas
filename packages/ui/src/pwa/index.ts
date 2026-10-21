import tokens from "@xos/tokens/tokens.json";

/**
 * Installable web apps (Section 4.10, A65-023, ADR 0052): what Atlas and Gateway share on the server for their web
 * manifest, service worker and offline page. Browser helpers live in ./client.ts.
 */

export { serviceWorkerScript, type ServiceWorkerConfig } from "./service-worker.ts";

/** Where each app serves its offline page; under /auth, which every route guard lets through. */
export const OFFLINE_PATH = "/auth/offline";

/** Response header naming the signed-in person's offline cache: a hash, never the id itself. */
export const OFFLINE_KEY_HEADER = "x-xos-offline-key";

/**
 * The key of a person's offline page cache: the first 128 bits of SHA-256 over their sign-in id, hex. The proxy sets
 * it on the pages it serves to that person, so the service worker files each page under its own person.
 */
export async function offlineKey(userId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`xos-offline:${userId}`)),
  );
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Theme = "dark" | "light" | "sunlight";
interface ColorToken {
  readonly name: string;
  readonly value: Readonly<Record<Theme, string>>;
}

/** A theme's color token, from the token source of truth (@xos/tokens). */
export function tokenColor(name: string, theme: Theme): string {
  const token = (tokens.color.tokens as readonly ColorToken[]).find((t) => t.name === name);
  const value = token?.value[theme];
  if (!value) throw new Error(`No ${theme} value for color token ${name}`);
  return value;
}

/** The manifest's background and theme colors: the page canvas of the app's default theme. */
export function manifestColors(theme: Theme): { background_color: string; theme_color: string } {
  const canvas = tokenColor("bg-canvas", theme);
  return { background_color: canvas, theme_color: canvas };
}

/** Browser toolbar colors for each color scheme, for a layout's viewport themeColor. */
export function themeColors(): { media: string; color: string }[] {
  return [
    { media: "(prefers-color-scheme: dark)", color: tokenColor("bg-canvas", "dark") },
    { media: "(prefers-color-scheme: light)", color: tokenColor("bg-canvas", "light") },
  ];
}
