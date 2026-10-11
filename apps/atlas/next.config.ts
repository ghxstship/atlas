import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@xos/i18n", "@xos/ia", "@xos/data", "@xos/icons", "@xos/ui"],
  typedRoutes: true,
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  // Playwright and local tools reach the dev server at 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
};

export default withNextIntl(config);
