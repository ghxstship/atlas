"use client";

import { useEffect } from "react";

/**
 * A device that already holds a grant arrives on next week's emailed link with no code to enter (B2, ADR 0141).
 * This posts to the link's open handler once per browser session: the database logs Opened and swaps the grant for a
 * fresh one, and the response sets the cookie. Nothing changes on the page.
 */
export function PackOpened({ token }: { token: string }) {
  useEffect(() => {
    const key = `xos-pack-opened:${token.slice(-8)}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage may be blocked; the open is then at worst logged once per visit.
    }
    void fetch(`/share/pack/${token}/open`, {
      method: "POST",
      body: new FormData(),
      redirect: "manual",
      credentials: "same-origin",
    }).catch(() => undefined);
  }, [token]);
  return null;
}
