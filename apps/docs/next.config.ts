import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@xos/i18n", "@xos/icons", "@xos/tokens", "@xos/ui"],
  // next dev writes an AGENTS.md whose em dashes the finish guard (Section 18, gate 2) refuses.
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  // Every page is prerendered except the help center index, which reads its search query on each
  // request, and the 404 page. The help index reads each shell's help (apps/<shell>/help) through
  // paths the tracer cannot follow, so without this a Vercel function would lack the articles and
  // answer 500 (RRR-119).
  outputFileTracingIncludes: {
    "/\\[locale\\]/help": [
      "../atlas/help/articles/**/*.md",
      "../atlas/help/whats-new.yaml",
      "../gateway/help/articles/**/*.md",
      "../compass/help/articles/**/*.md",
    ],
  },
};

export default config;
