"use client";

import { reportClientError } from "@xos/infra/observability/browser";
import { gatewayFatal } from "@xos/i18n/extracts";
import { defaultLocale } from "@xos/i18n/locales";
import { useEffect } from "react";
import "./globals.css";

/**
 * Last-resort boundary when the root layout itself fails. The locale provider is gone with it, so
 * the copy comes from a generated extract of the source catalog (only these strings, A24-009).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const copy = gatewayFatal[defaultLocale];
  useEffect(() => {
    console.error(error);
    reportClientError(error);
  }, [error]);
  return (
    <html lang={defaultLocale}>
      <body>
        <main className="mx-auto flex max-w-layout-form flex-col items-center gap-16 px-24 py-64 text-center">
          <h1 className="text-heading-20 font-semibold">{copy.title}</h1>
          <p className="text-text-14 text-text-secondary">{copy.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-control-md items-center rounded-control bg-accent px-12 text-label-13 text-accent-text-on"
          >
            {copy.action}
          </button>
        </main>
      </body>
    </html>
  );
}
