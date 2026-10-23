import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/**
 * Messages reach next-intl precompiled (i18n/request.ts, ADR 0027), so `use-intl/format-message`
 * resolves to its format-only build and the ICU parser never ships, as in Atlas. use-intl is
 * next-intl's dependency, so it is resolved from there; Turbopack takes a project-relative path.
 */
const require = createRequire(import.meta.url);
const formatOnly = createRequire(require.resolve("next-intl")).resolve(
  "use-intl/format-message/format-only",
);
const formatOnlyAlias = `./${relative(process.cwd(), formatOnly).split(sep).join("/")}`;

const config: NextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: process.env["XOS_SOURCEMAPS"] === "1",
  poweredByHeader: false,
  transpilePackages: [
    "@xos/i18n",
    "@xos/ia",
    "@xos/data",
    "@xos/icons",
    "@xos/infra",
    "@xos/schemas",
    "@xos/ui",
  ],
  typedRoutes: true,
  // Generated documents render with pdfkit, which reads its own files at runtime; it stays a
  // server-side external, loaded from node_modules and never bundled (ADR 0031).
  serverExternalPackages: ["pdfkit"],
  turbopack: { resolveAlias: { "use-intl/format-message": formatOnlyAlias } },
  // The release on browser error reports (instrumentation-client.ts). Always defined, so the build
  // inlines a string instead of shipping a process.env lookup.
  env: { NEXT_PUBLIC_XOS_RELEASE: process.env["VERCEL_GIT_COMMIT_SHA"] ?? "" },
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  // Playwright and local tools reach the dev server at 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Turbopack merges chunks below this raw size (default 50,000), as in Atlas: each chunk carries
    // its own wrapper and compresses alone, so fewer, larger chunks are less gzip per page; the cost
    // is shared code merged into page chunks, fetched again on navigation (ADR 0027).
    turbopackChunking: { minChunkSize: 200_000 },
    // Support and feedback screenshots go up through server actions, and the bucket takes files up to 5 MB
    // (1034); Next's default 1 MB body refused most phone screenshots (A96).
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default withNextIntl(config);
