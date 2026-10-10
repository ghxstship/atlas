import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@xos/i18n", "@xos/ia", "@xos/data", "@xos/icons"],
  typedRoutes: true,
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
};

export default withNextIntl(config);
