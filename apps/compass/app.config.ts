import { existsSync, readFileSync } from "node:fs";
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
 * Sign in with Apple (owner decision 20). EXPO_PUBLIC_APPLE_SIGN_IN, a public build value ("1"), turns it on: the
 * build asks for the Sign in with Apple capability (ios.usesAppleSignIn, which EAS enables on the App ID) and
 * expo-apple-authentication's config plugin adds the entitlement. Unset, the build has neither, and Compass shows no
 * Apple button, nor a Google one on iOS (src/domain/appleSignIn.ts).
 */
export function withAppleSignIn(config: ExpoConfig, flag: string | undefined): ExpoConfig {
  const value = flag?.trim().toLowerCase();
  if (value !== "1" && value !== "true") return config;
  return {
    ...config,
    ios: { ...config.ios, usesAppleSignIn: true },
    plugins: [...(config.plugins ?? []), "expo-apple-authentication"],
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

/** A release profile: preview, production, or a tenant's branded build (`tenant-<slug>`, withTenant). */
export function isReleaseProfile(profile: string): boolean {
  return (RELEASE_PROFILES as readonly string[]).includes(profile) || profile.startsWith("tenant-");
}

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
  if (env["EAS_BUILD"] !== "true" || !isReleaseProfile(profile)) {
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
    // A tenant build already carries its own icon (withTenant).
    ...(iconPresent && !config.icon ? { icon: APP_ICON } : {}),
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

/**
 * EAS Update (Section 13 Distribution: "Over-the-air updates via EAS Update apply only to JavaScript changes
 * and follow staged rollout"). Each build profile in eas.json names its channel (development, preview,
 * production, tenant-<slug>); `eas update --channel <name> --rollout-percentage <n>` stages an update.
 * The fingerprint runtime version changes with any native change, so an update only ever reaches binaries
 * built from the same native code: JavaScript and assets only. Updates run in EAS builds (and with
 * XOS_UPDATES=1); local and Maestro builds always run their embedded bundle.
 */
export function withUpdates(config: ExpoConfig, env: Env): ExpoConfig {
  const projectId = (config.extra?.["eas"] as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return config;
  return {
    ...config,
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      ...config.updates,
      url: `https://u.expo.dev/${projectId}`,
      enabled: env["EAS_BUILD"] === "true" || env["XOS_UPDATES"] === "1",
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
    },
  };
}

/**
 * Enterprise branded builds (Section 12 Mobile: "a dedicated branded build through EAS build profiles
 * generated per tenant: bundle identifier, app name, icon, splash and store listing metadata"). Each tenant
 * has a definition at tenants/<slug>.json, written by scripts/tenant-profile.ts, which also adds the
 * `tenant-<slug>` build and submit profiles to eas.json; that build profile sets XOS_TENANT=<slug>. Values
 * that wait on the tenant's own accounts (its EAS project, Apple team, App Store Connect app) are OWNER_
 * tokens until filled, and a release build stops while any is left (releaseConfigProblems).
 */
export interface TenantBuild {
  readonly slug: string;
  /** The XOS org the build is for; Compass opens on it and wears its brand before sign-in. */
  readonly orgSlug: string;
  readonly name: string;
  readonly bundleIdentifier: string;
  readonly androidPackage: string;
  readonly scheme: string;
  /** Uppercase #RRGGBB: the splash and adaptive icon background, and the brand before sign-in. */
  readonly accent: string;
  /** Paths relative to apps/compass. */
  readonly icon: string;
  readonly splash: string;
  readonly storeConfig: string;
  /** The tenant's EAS project (a UUID), an OWNER_ token until created. */
  readonly easProjectId: string;
  /** Universal link hosts on the tenant's custom domains, as XOS_UNIVERSAL_LINK_HOSTS spells them. */
  readonly universalLinkHosts: string;
}

export const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SCHEME = /^[a-z][a-z0-9+.-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_TOKEN = /^OWNER_[A-Z0-9_]+$/;
const HEX = /^#[0-9A-F]{6}$/;
const LOCAL_PATH = /^\.\/tenants\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Why a tenant definition cannot build; empty when it can. */
export function tenantProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object")
    return ["the tenant definition is not an object"];
  const t = value as Record<string, unknown>;
  const problems: string[] = [];
  const check = (key: keyof TenantBuild, ok: (v: string) => boolean, what: string) => {
    const v = t[key];
    if (typeof v !== "string" || !ok(v)) problems.push(`${key} must be ${what}`);
  };
  check("slug", (v) => TENANT_SLUG.test(v), "lowercase letters, digits and dashes");
  check("orgSlug", (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v), "the XOS org slug");
  check("name", (v) => v.trim().length > 0 && v.length <= 30, "1 to 30 characters");
  check("bundleIdentifier", (v) => BUNDLE_ID.test(v), "a reverse-DNS iOS bundle identifier");
  check("androidPackage", (v) => ANDROID_PACKAGE.test(v), "a lowercase Android package name");
  check("scheme", (v) => SCHEME.test(v), "a lowercase URL scheme");
  check("accent", (v) => HEX.test(v), "an uppercase #RRGGBB color");
  check("icon", (v) => LOCAL_PATH.test(v), "a file under ./tenants/<slug>/");
  check("splash", (v) => LOCAL_PATH.test(v), "a file under ./tenants/<slug>/");
  check("storeConfig", (v) => LOCAL_PATH.test(v), "a file under ./tenants/<slug>/");
  check("easProjectId", (v) => UUID.test(v) || OWNER_TOKEN.test(v), "a UUID or an OWNER_ token");
  check(
    "universalLinkHosts",
    (v) => v === "" || universalLinkHosts(v).length === v.split(",").length,
    "empty or atlas:<host>,gateway:<host>",
  );
  if (
    typeof t["bundleIdentifier"] === "string" &&
    t["bundleIdentifier"] === "pro.ghxstship.compass"
  )
    problems.push("bundleIdentifier must differ from the platform build's");
  return problems;
}

export function readTenant(projectRoot: string, slug: string): TenantBuild {
  if (!TENANT_SLUG.test(slug)) throw new Error(`XOS_TENANT "${slug}" is not a tenant slug.`);
  const file = join(projectRoot, "tenants", `${slug}.json`);
  if (!existsSync(file))
    throw new Error(`No tenant definition at tenants/${slug}.json; run scripts/tenant-profile.ts.`);
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const problems = tenantProblems(value);
  if (problems.length > 0)
    throw new Error(`tenants/${slug}.json is not valid:\n- ${problems.join("\n- ")}`);
  return value as TenantBuild;
}

/** The App Group a build's app and widget extension share: `group.` and the app's bundle identifier. */
export function appGroupFor(bundleIdentifier: string): string {
  return `group.${bundleIdentifier}`;
}

export function withTenant(config: ExpoConfig, tenant: TenantBuild): ExpoConfig {
  const projectId = OWNER_TOKEN.test(tenant.easProjectId) ? undefined : tenant.easProjectId;
  return {
    ...config,
    name: tenant.name,
    slug: `xos-compass-${tenant.slug}`,
    scheme: tenant.scheme,
    icon: tenant.icon,
    // The launch screen: the tenant's splash art on its accent (expo-splash-screen's config plugin).
    plugins: [
      ...(config.plugins ?? []),
      [
        "expo-splash-screen",
        {
          image: tenant.splash,
          backgroundColor: tenant.accent,
          imageWidth: 200,
          resizeMode: "contain",
        },
      ],
    ],
    ios: {
      ...config.ios,
      bundleIdentifier: tenant.bundleIdentifier,
      entitlements: {
        ...config.ios?.entitlements,
        "com.apple.security.application-groups": [appGroupFor(tenant.bundleIdentifier)],
      },
    },
    android: {
      ...config.android,
      package: tenant.androidPackage,
      adaptiveIcon: { foregroundImage: tenant.icon, backgroundColor: tenant.accent },
    },
    extra: {
      ...config.extra,
      eas: { ...(config.extra?.["eas"] as object | undefined), projectId },
      tenant: {
        slug: tenant.slug,
        orgSlug: tenant.orgSlug,
        name: tenant.name,
        accent: tenant.accent,
      },
    },
  };
}

/** What stops a tenant's release build: values still waiting on the tenant's accounts, or missing art. */
export function tenantReleaseProblems(
  tenant: TenantBuild,
  env: Env,
  fileExists: (path: string) => boolean,
): string[] {
  const profile = env["EAS_BUILD_PROFILE"] ?? "";
  if (env["EAS_BUILD"] !== "true" || !profile.startsWith("tenant-")) return [];
  const problems: string[] = [];
  if (OWNER_TOKEN.test(tenant.easProjectId))
    problems.push(`tenants/${tenant.slug}.json easProjectId is still ${tenant.easProjectId}`);
  for (const path of [tenant.icon, tenant.splash, tenant.storeConfig]) {
    if (!fileExists(path)) problems.push(`the tenant file ${path} is missing`);
  }
  return problems;
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  refuseTestOnlySwitches(process.env);
  const slug = process.env["XOS_TENANT"];
  const tenant = slug ? readTenant(projectRoot, slug) : null;
  const exists = (path: string) => existsSync(join(projectRoot, path));
  if (tenant) {
    const problems = tenantReleaseProblems(tenant, process.env, exists);
    if (problems.length > 0)
      throw new Error(
        `Compass tenant build "${tenant.slug}" is missing configuration:\n- ${problems.join("\n- ")}\n` +
          "Fill the tenant's OWNER_ values (infra/runbooks/production.md, Compass tenant builds).",
      );
  }
  const hosts = tenant
    ? tenant.universalLinkHosts
    : (process.env["XOS_UNIVERSAL_LINK_HOSTS"] ?? PRODUCTION_LINK_HOSTS);
  const linked = withAppleSignIn(
    withGoogleSignIn(
      withUniversalLinks(config as ExpoConfig, universalLinkHosts(hosts)),
      process.env["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"],
    ),
    process.env["EXPO_PUBLIC_APPLE_SIGN_IN"],
  );
  const branded = tenant ? withTenant(linked, tenant) : linked;
  return withStoreBuild(
    withUpdates(branded, process.env),
    process.env,
    tenant ? exists(tenant.icon) : exists(APP_ICON),
  );
};
