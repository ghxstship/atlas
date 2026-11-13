"use client";

import { setNonce } from "get-nonce";

/**
 * Hands this response's Content Security Policy nonce to the stylesheet dialogs inject when they lock the page's
 * scroll (react-remove-scroll, through Radix): style-src allows only the site and the nonce in production, and
 * without it every open dialog logs a CSP violation and the body never stops scrolling (crawl 4.9). It is set while
 * rendering, before any dialog can open, rather than in an effect, which a dialog open on mount would run first.
 */
export function StyleNonce({ nonce }: { nonce: string | null }): null {
  if (nonce && typeof document !== "undefined") setNonce(nonce);
  return null;
}
