import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Build-time additions to app.json: universal links for Continue on another device (ADR 0030).
 *
 * XOS_UNIVERSAL_LINK_HOSTS lists the production hosts of Atlas and Gateway, comma-separated, each as
 * `atlas:host` or `gateway:host` (for example `atlas:atlas.example.com,gateway:gateway.example.com`).
 * Unset, the build claims the GHXSTSHIP production hosts the owner confirmed on 2026-10-20
 * (PRODUCTION_LINK_HOSTS); a self-hosted build names its own, and an empty value turns universal
 * links off, for example for a device build signed by a team without the Associated Domains
 * capability. Each host becomes an iOS associated domain (applinks) and a verified Android App Link
 * for that shell's paths; the shells serve the matching apple-app-site-association and
 * assetlinks.json files once COMPASS_APPLE_TEAM_IDS and COMPASS_ANDROID_CERT_SHA256 are set.
 */
export const PRODUCTION_LINK_HOSTS = "atlas:atlas.ghxstship.tech,gateway:gateway.ghxstship.tech";

/**
 * The web paths each shell lets Compass claim. Expo loads this file without the workspace's TypeScript
 * packages, so it restates HANDOFF_PATHS from @xos/ia/handoff; test/handoff.test.ts keeps them equal.
 */
export const LINK_PATHS = {
  atlas: ["/*/r/*"],
  gateway: ["/work/engagements/*"],
} as const;

interface LinkHost {
  readonly shell: keyof typeof LINK_PATHS;
  readonly host: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function universalLinkHosts(value: string | undefined): LinkHost[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .flatMap((entry): LinkHost[] => {
      const [shell, host] = entry.split(":");
      if ((shell !== "atlas" && shell !== "gateway") || !host || !HOST.test(host)) return [];
      return [{ shell, host }];
    });
}

/** Android path prefix for an apple-app-site-association pattern (`/work/engagements/*`). */
function androidPathPattern(pattern: string): string {
  return pattern.replaceAll("*", ".*");
}

export function withUniversalLinks(config: ExpoConfig, hosts: readonly LinkHost[]): ExpoConfig {
  if (hosts.length === 0) return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      associatedDomains: [
        ...(config.ios?.associatedDomains ?? []),
        ...hosts.map((h) => `applinks:${h.host}`),
      ],
    },
    android: {
      ...config.android,
      intentFilters: [
        ...(config.android?.intentFilters ?? []),
        ...hosts.map((h) => ({
          action: "VIEW",
          autoVerify: true,
          category: ["BROWSABLE", "DEFAULT"],
          data: LINK_PATHS[h.shell].map((pattern) => ({
            scheme: "https",
            host: h.host,
            pathPattern: androidPathPattern(pattern),
          })),
        })),
      ],
    },
  };
}

export default ({ config }: ConfigContext): ExpoConfig =>
  withUniversalLinks(
    config as ExpoConfig,
    universalLinkHosts(process.env["XOS_UNIVERSAL_LINK_HOSTS"] ?? PRODUCTION_LINK_HOSTS),
  );
