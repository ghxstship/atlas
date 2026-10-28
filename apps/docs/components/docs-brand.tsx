"use client";

/**
 * The docs brand mark (A138, ADR 0066): the platform name, or, in an org's docs, its logo and name.
 * The proxy hands the org's brand over in a cookie scoped to its docs; pages stay prerendered, so the
 * mark reads it after hydration. In docs under /o/<org-slug>/, links to other docs pages are kept
 * inside the org's docs.
 */
import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import {
  BRAND_COOKIE,
  decodeBrand,
  readCookie,
  scopedPath,
  type ScopedBrand,
} from "@/lib/brand.ts";

let cachedRaw: string | null = null;
let cached: ScopedBrand | null = null;

function snapshot(): ScopedBrand | null {
  const raw = readCookie(document.cookie, BRAND_COOKIE);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = decodeBrand(raw);
  }
  return cached;
}

const subscribe = () => () => {};

function scopeAnchor(anchor: HTMLAnchorElement, base: string): void {
  const href = anchor.getAttribute("href");
  if (href === null || !href.startsWith("/") || href.startsWith("//")) return;
  const scoped = scopedPath(href, base);
  if (scoped !== href) anchor.setAttribute("href", scoped);
}

export function DocsBrandMark({
  locale,
  platformName,
}: {
  locale: string;
  platformName: string;
}): ReactElement {
  const brand = useSyncExternalStore(subscribe, snapshot, () => null);

  useEffect(() => {
    if (brand === null || !brand.base) return;
    document
      .querySelectorAll<HTMLAnchorElement>("a[href]")
      .forEach((a) => scopeAnchor(a, brand.base));
    // Links rendered later are scoped as they are followed.
    const onActivate = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (anchor instanceof HTMLAnchorElement) scopeAnchor(anchor, brand.base);
    };
    document.addEventListener("click", onActivate, true);
    document.addEventListener("auxclick", onActivate, true);
    return () => {
      document.removeEventListener("click", onActivate, true);
      document.removeEventListener("auxclick", onActivate, true);
    };
  }, [brand]);

  const className =
    "flex items-center gap-8 font-semibold text-text-14 text-text-primary no-underline";
  if (brand === null) {
    return (
      <a href={`/${locale}`} className={className} data-docs-platform-mark="">
        {platformName}
      </a>
    );
  }
  const light = brand.logoLightUrl ?? brand.logoDarkUrl;
  const dark = brand.logoDarkUrl ?? brand.logoLightUrl;
  return (
    <a href={`${brand.base}/${locale}`} className={className}>
      {light !== null && dark !== null && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- an org's logo from its public bucket, of unknown size */}
          <img src={light} alt="" className="docs-logo-light h-24 w-auto" />
          {/* eslint-disable-next-line @next/next/no-img-element -- as above, for the dark theme */}
          <img src={dark} alt="" className="docs-logo-dark h-24 w-auto" />
        </>
      )}
      <span>{brand.name}</span>
    </a>
  );
}
