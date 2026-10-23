import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/**
 * Messages reach next-intl precompiled (i18n/request.ts, ADR 0027), so `use-intl/format-message` resolves to its
 * format-only build and the ICU parser never ships, as in Atlas and Gateway. use-intl is next-intl's dependency, so
 * it is resolved from there; Turbopack takes a project-relative path.
 */
const require = createRequire(import.meta.url);
const formatOnly = createRequire(require.resolve("next-intl")).resolve(
  "use-intl/format-message/format-only",
);
const formatOnlyAlias = `./${relative(process.cwd(), formatOnly).split(sep).join("/")}`;

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@xos/i18n", "@xos/ia", "@xos/data", "@xos/icons", "@xos/ui"],
  typedRoutes: true,
  turbopack: { resolveAlias: { "use-intl/format-message": formatOnlyAlias } },
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  // Playwright and local tools reach the dev server at 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
};

export default withNextIntl(config);
