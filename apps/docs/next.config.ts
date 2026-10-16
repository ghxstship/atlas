import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@xos/i18n", "@xos/icons", "@xos/tokens", "@xos/ui"],
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
};

export default config;
