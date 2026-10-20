"use client";

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

/**
 * A next/link that prefetches when the person points at, touches or focuses it, not when it scrolls
 * into view. For dense navigation such as the project tab bar: Next prefetches every link in the
 * viewport, and each prefetch of a dynamic route renders its loading state on the server and
 * fetches its chunks, about 1 KB of script per link before anyone chooses one (gate 10).
 */
export function IntentLink({
  href,
  onMouseEnter,
  onTouchStart,
  onFocus,
  ...rest
}: Omit<ComponentProps<typeof Link<Route>>, "href" | "prefetch"> & { href: Route }) {
  const router = useRouter();
  const prefetch = () => router.prefetch(href);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(event) => {
        prefetch();
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        prefetch();
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        prefetch();
        onFocus?.(event);
      }}
    />
  );
}
