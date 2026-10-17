import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@xos/i18n",
    "@xos/ia",
    "@xos/data",
    "@xos/icons",
    "@xos/infra",
    "@xos/integrations",
    "@xos/ui",
  ],
  typedRoutes: true,
  // The release on browser error reports (instrumentation-client.ts). Always defined, so the build
  // inlines a string instead of shipping a process.env lookup.
  env: { NEXT_PUBLIC_XOS_RELEASE: process.env["VERCEL_GIT_COMMIT_SHA"] ?? "" },
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  // Playwright and local tools reach the dev server at 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  // Attachments upload through server actions; the bucket allows 50 MiB (migration 0590), above Next's 1 MB default.
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
};

export default withNextIntl(config);
