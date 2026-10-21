import { existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Test-only switches for Maestro builds:
 * - EXPO_PUBLIC_XOS_FAKE_RECORDER (A66) swaps the voice-note microphone for a silent fake
 *   (src/runtime/voiceRecorder.ts).
 * - EXPO_PUBLIC_XOS_FAKE_NFC (A92) swaps the NFC reader for an on-screen test tag
 *   (src/runtime/nfc.ts), since a simulator has no NFC radio.
 */
export const TEST_ONLY_SWITCHES = [
  "EXPO_PUBLIC_XOS_FAKE_RECORDER",
  "EXPO_PUBLIC_XOS_FAKE_NFC",
] as const;

/**
 * Refuses test-only switches in a build meant for people. EAS builds are the ones that reach
 * TestFlight, Play and the stores (ADR 0033), so none carries one, whatever the profile. The release
 * guard below (releaseConfigProblems) checks the server URLs of release profiles.
 */
export function refuseTestOnlySwitches(env: Readonly<Record<string, string | undefined>>): void {
  if (env["EAS_BUILD"] !== "true") return;
  for (const name of TEST_ONLY_SWITCHES) {
    if (env[name] === "1")
      throw new Error(`${name} is for local and CI Maestro builds only; unset it for EAS builds.`);
  }
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

/**
 * Store builds (RRR-113, `eas.json`). The EAS environment of each build profile supplies these values; none is
 * committed:
 * - XOS_APPLE_TEAM_ID: the Apple Developer team id (10 characters). @bacons/apple-targets signs the widget
 *   extension with ios.appleTeamId; EAS signs every target itself, so the value only matters for local
 *   device builds. Anything that is not a team id is ignored.
 * - GOOGLE_SERVICES_JSON: an EAS file variable with the Firebase Android config, which Android needs for an
 *   Expo push token (FCM). Without it Compass still runs and only Android push registration is skipped.
 *
 * The app icon is the owner's brand asset: a 1024 x 1024 PNG without transparency at APP_ICON. Until it
 * exists, local builds use Expo's blank icon and a release build on EAS stops, because App Store Connect
 * rejects an icon with an alpha channel.
 */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;

export const APP_ICON = "./assets/icon.png";

/** The EAS build profiles that reach testers or the stores. */
export const RELEASE_PROFILES = ["preview", "production"] as const;

type Env = Readonly<Record<string, string | undefined>>;

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1"
    );
  } catch {
    return false;
  }
}

/**
 * Why a build would ship pointing at the wrong servers. Compass falls back to a local stack when the
 * EXPO_PUBLIC_* values are missing (src/runtime/platform.ts), which is right in development and broken in a
 * tester's hands, so a preview or production build on EAS stops here instead.
 */
export function releaseConfigProblems(env: Env, iconPresent = true): string[] {
  const profile = env["EAS_BUILD_PROFILE"] ?? "";
  if (env["EAS_BUILD"] !== "true" || !(RELEASE_PROFILES as readonly string[]).includes(profile)) {
    return [];
  }
  const problems: string[] = [];
  for (const name of [
    "EXPO_PUBLIC_SUPABASE_URL",
    "EXPO_PUBLIC_ATLAS_URL",
    "EXPO_PUBLIC_GATEWAY_URL",
  ]) {
    if (!isHttpsUrl(env[name])) problems.push(`${name} must be an https URL that is not local`);
  }
  if (!env["EXPO_PUBLIC_SUPABASE_ANON_KEY"])
    problems.push("EXPO_PUBLIC_SUPABASE_ANON_KEY is not set");
  if (!iconPresent)
    problems.push(`the app icon ${APP_ICON} (1024 x 1024 PNG, no transparency) is missing`);
  return problems.map((p) => `${p} (EAS environment "${profile}")`);
}

export function withStoreBuild(config: ExpoConfig, env: Env, iconPresent = false): ExpoConfig {
  const problems = releaseConfigProblems(env, iconPresent);
  if (problems.length > 0) {
    throw new Error(
      `Compass release build is missing configuration:\n- ${problems.join("\n- ")}\n` +
        "Set the values with `eas env:create` (infra/runbooks/production.md, Compass store release).",
    );
  }
  const teamId = env["XOS_APPLE_TEAM_ID"];
  const googleServices = env["GOOGLE_SERVICES_JSON"];
  return {
    ...config,
    ...(iconPresent ? { icon: APP_ICON } : {}),
    ios: {
      ...config.ios,
      ...(teamId && APPLE_TEAM_ID.test(teamId) ? { appleTeamId: teamId } : {}),
    },
    android: {
      ...config.android,
      ...(googleServices ? { googleServicesFile: googleServices } : {}),
    },
  };
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  refuseTestOnlySwitches(process.env);
  return withStoreBuild(
    withGoogleSignIn(
      withUniversalLinks(
        config as ExpoConfig,
        universalLinkHosts(process.env["XOS_UNIVERSAL_LINK_HOSTS"] ?? PRODUCTION_LINK_HOSTS),
      ),
      process.env["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"],
    ),
    process.env,
    existsSync(join(projectRoot, APP_ICON)),
  );
};
