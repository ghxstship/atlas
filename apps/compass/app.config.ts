import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Build-time additions to app.json: universal links for Continue on another device (ADR 0030).
 *
 * XOS_UNIVERSAL_LINK_HOSTS lists the production hosts of Atlas and Gateway, comma-separated, each as
 * `atlas:host` or `gateway:host` (for example `atlas:atlas.example.com,gateway:gateway.example.com`).
 * The production domains are the owner's decision, so the variable is unset by default and Compass
 * opens handoff links through its compass:// scheme only. Set, each host becomes an iOS associated
 * domain (applinks) and a verified Android App Link for that shell's paths; the shells serve the
 * matching apple-app-site-association and assetlinks.json files.
 */
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

/**
 * Sign in with Google (ADR 0036). Google returns to an iOS app through a URL scheme made from its iOS
 * client ID (`com.googleusercontent.apps.<id>`), which the SDK's config plugin adds to Info.plist.
 * EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is public; unset, the plugin is left out (without options it would
 * expect Firebase files) and Compass does not offer Google on iOS. Android needs no plugin.
 */
export function googleIosUrlScheme(iosClientId: string | undefined): string | null {
  const id = /^(\d+-[a-z0-9]+)\.apps\.googleusercontent\.com$/.exec(iosClientId?.trim() ?? "");
  return id ? `com.googleusercontent.apps.${id[1]}` : null;
}

export function withGoogleSignIn(config: ExpoConfig, iosClientId: string | undefined): ExpoConfig {
  const iosUrlScheme = googleIosUrlScheme(iosClientId);
  if (!iosUrlScheme) return config;
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ["@react-native-google-signin/google-signin", { iosUrlScheme }],
    ],
  };
}

export default ({ config }: ConfigContext): ExpoConfig =>
  withGoogleSignIn(
    withUniversalLinks(
      config as ExpoConfig,
      universalLinkHosts(process.env["XOS_UNIVERSAL_LINK_HOSTS"]),
    ),
    process.env["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"],
  );
