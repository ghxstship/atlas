# ConsentBanner

ConsentBanner mirrors the cookie banner the shells ship, for use in page designs.

It documents `apps/atlas/components/privacy/cookie-banner.tsx`; public pages reuse that banner, its consent log and its Global Privacy Control handling, and this is not a second implementation. Accept and Reject are the same size and variant. Categories sit behind Choose, and none is pre-checked.

With `gpc`, the browser sends Global Privacy Control: the banner shows the confirmation "Opt-Out Request Honored" and offers no choices, because the signal is already a refusal.

The consumer provides the copy from the `compliance.cookies` catalog.
