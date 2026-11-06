"use client";

import { useEffect } from "react";

/**
 * A device that already holds a grant arrives on next week's emailed link with no code to enter (B2, ADR 0141).
 * This posts to the link's open handler once per browser session: the database logs Opened and swaps the grant for a
 * fresh one, and the response sets the cookie. Nothing changes on the page.
 *
 * `opened` says this page load is the code form's return, which already logged the open and earned a grant: it marks the
 * session and posts nothing, so coming back from an item neither logs a second open nor swaps the grant under the page.
 */
export function PackOpened({ token, opened }: { token: string; opened: boolean }) {
  useEffect(() => {
    const key = `xos-pack-opened:${token.slice(-8)}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage may be blocked; the open is then at worst logged once per visit.
      if (opened) return;
    }
    if (opened) return;
    void fetch(`/share/pack/${token}/open`, {
      method: "POST",
      body: new FormData(),
      redirect: "manual",
      credentials: "same-origin",
    }).catch(() => undefined);
  }, [token, opened]);
  return null;
}
