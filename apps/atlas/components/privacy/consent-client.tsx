"use client";

import dynamic from "next/dynamic";

/**
 * The banner's client code as a chunk of its own. The root layout shows the banner on every route
 * until the visitor chooses, so importing it directly would add its script to every page's first
 * load, including for the visitors who have already chosen and never see it (route JavaScript
 * budget, ADR 0027). The server still renders the banner's forms, which post to the server action
 * before any script runs; the chunk arrives after and adds the browser's Global Privacy Control check.
 */
export const RoutedConsentBanner = dynamic(() =>
  import("./consent-banner-routed").then((m) => m.RoutedConsentBanner),
);
