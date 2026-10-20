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
 * Store builds (RRR-113, `eas.json`). The EAS environment of each build profile supplies these values; none is
 * committed:
 * - XOS_APPLE_TEAM_ID: the Apple Developer team id (10 characters). @bacons/apple-targets signs the widget
 *   extension with ios.appleTeamId; EAS signs every target itself, so the value only matters for local
 *   device builds. Anything that is not a team id is ignored.
 * - GOOGLE_SERVICES_JSON: an EAS file variable with the Firebase Android config, which Android needs for an
 *   Expo push token (FCM). Without it Compass still runs and only Android push registration is skipped.
 */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;

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
export function releaseConfigProblems(env: Env): string[] {
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
  return problems.map((p) => `${p} (EAS environment "${profile}")`);
}

export function withStoreBuild(config: ExpoConfig, env: Env): ExpoConfig {
  const problems = releaseConfigProblems(env);
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

export default ({ config }: ConfigContext): ExpoConfig =>
  withStoreBuild(
    withUniversalLinks(
      config as ExpoConfig,
      universalLinkHosts(process.env["XOS_UNIVERSAL_LINK_HOSTS"]),
    ),
    process.env,
  );
