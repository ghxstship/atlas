/**
 * Per-tenant EAS profiles for Enterprise branded Compass builds (Section 12 Mobile, A65-011 part 3). The
 * plan feature `branded_compass_build` entitles an org to its own app: its name, bundle identifier, icon,
 * splash and store listing. This writes, for one tenant:
 *
 *   tenants/<slug>.json                the build definition app.config.ts reads when XOS_TENANT=<slug>
 *   tenants/<slug>/store.config.json   the App Store listing (eas metadata), from store/store.config.json
 *   eas.json                           build profile `tenant-<slug>` (extends production, its own update
 *                                      channel) and submit profile `tenant-<slug>`
 *
 * Values that wait on the tenant's accounts stay OWNER_ tokens (its EAS project, Apple team, App Store
 * Connect app, Play service account), and the icon and splash are the tenant's art to put at
 * tenants/<slug>/icon.png and splash.png. A tenant release build stops while any is missing
 * (app.config.ts tenantReleaseProblems, scripts/store-preflight.ts). Nothing here signs in anywhere.
 *
 *   node --experimental-strip-types scripts/tenant-profile.ts --slug acme --org acme-live \
 *     --name "Acme Crew" --bundle-id com.acme.crew [--android-package com.acme.crew] [--scheme acmecrew] \
 *     [--accent "#B45309"] [--hosts atlas:atlas.acme.example,gateway:crew.acme.example] \
 *     [--eas-project-id <uuid>]
 *   node --experimental-strip-types scripts/tenant-profile.ts --check
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tenantProblems, type TenantBuild } from "../app.config.ts";

type Json = Record<string, unknown>;

export interface TenantArgs {
  readonly slug: string;
  readonly orgSlug: string;
  readonly name: string;
  readonly bundleIdentifier: string;
  readonly androidPackage?: string;
  readonly scheme?: string;
  readonly accent?: string;
  readonly hosts?: string;
  readonly easProjectId?: string;
}

const FLAGS: Readonly<Record<string, keyof TenantArgs>> = {
  "--slug": "slug",
  "--org": "orgSlug",
  "--name": "name",
  "--bundle-id": "bundleIdentifier",
  "--android-package": "androidPackage",
  "--scheme": "scheme",
  "--accent": "accent",
  "--hosts": "hosts",
  "--eas-project-id": "easProjectId",
};

/** The flags as tenant arguments, or the reason they cannot be. */
export function parseArgs(argv: readonly string[]): TenantArgs | { readonly error: string } {
  const out: Partial<Record<keyof TenantArgs, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i] ?? ""];
    const value = argv[i + 1];
    if (!key || value === undefined)
      return { error: `Unknown or incomplete flag: ${argv[i] ?? ""}` };
    out[key] = value;
  }
  for (const required of ["slug", "orgSlug", "name", "bundleIdentifier"] as const) {
    if (!out[required]) return { error: `Missing --${required === "orgSlug" ? "org" : required}` };
  }
  return out as unknown as TenantArgs;
}

/** The build definition for a tenant, with defaults derived from its bundle identifier. */
export function tenantDefinition(args: TenantArgs): TenantBuild {
  const dir = `./tenants/${args.slug}`;
  return {
    slug: args.slug,
    orgSlug: args.orgSlug,
    name: args.name,
    bundleIdentifier: args.bundleIdentifier,
    androidPackage: args.androidPackage ?? args.bundleIdentifier.toLowerCase().replaceAll("-", "_"),
    scheme: args.scheme ?? args.slug.replaceAll("-", ""),
    accent: (args.accent ?? "#4F57D9").toUpperCase(),
    icon: `${dir}/icon.png`,
    splash: `${dir}/splash.png`,
    storeConfig: `${dir}/store.config.json`,
    easProjectId: args.easProjectId ?? "OWNER_EAS_PROJECT_ID",
    universalLinkHosts: args.hosts ?? "",
  };
}

export function profileName(slug: string): string {
  return `tenant-${slug}`;
}

/** eas.json with the tenant's build and submit profiles added (or replaced). */
export function withTenantProfiles(easJson: Json, tenant: TenantBuild): Json {
  const name = profileName(tenant.slug);
  const build = (easJson["build"] ?? {}) as Json;
  const submit = (easJson["submit"] ?? {}) as Json;
  return {
    ...easJson,
    build: {
      ...build,
      [name]: { extends: "production", channel: name, env: { XOS_TENANT: tenant.slug } },
    },
    submit: {
      ...submit,
      [name]: {
        ios: {
          ascAppId: "OWNER_ASC_APP_ID",
          appleTeamId: "OWNER_APPLE_TEAM_ID",
          language: "en-US",
          metadataPath: tenant.storeConfig,
        },
        android: {
          serviceAccountKeyPath: "OWNER_PLAY_SERVICE_ACCOUNT_KEY_PATH",
          track: "internal",
          releaseStatus: "completed",
          changesNotSentForReview: false,
        },
      },
    },
  };
}

/**
 * The tenant's App Store listing: the platform listing with the tenant's app name as every title. The
 * review contact and the rest stay the platform's until the tenant replaces them.
 */
export function tenantStoreConfig(storeConfig: Json, tenant: TenantBuild): Json {
  const apple = (storeConfig["apple"] ?? {}) as Json;
  const info = (apple["info"] ?? {}) as Record<string, Json>;
  return {
    ...storeConfig,
    apple: {
      ...apple,
      info: Object.fromEntries(
        Object.entries(info).map(([locale, entry]) => [locale, { ...entry, title: tenant.name }]),
      ),
    },
  };
}

/** Problems across every committed tenant: invalid definitions and eas.json profiles out of step. */
export function checkTenants(
  easJson: Json,
  tenants: readonly { readonly file: string; readonly value: unknown }[],
): string[] {
  const problems: string[] = [];
  const build = (easJson["build"] ?? {}) as Record<string, Json>;
  const slugs = new Set<string>();
  for (const { file, value } of tenants) {
    const found = tenantProblems(value);
    problems.push(...found.map((p) => `${file}: ${p}`));
    if (found.length > 0) continue;
    const tenant = value as TenantBuild;
    slugs.add(tenant.slug);
    if (file !== `${tenant.slug}.json`)
      problems.push(`${file}: slug ${tenant.slug} differs from the file name`);
    const profile = build[profileName(tenant.slug)];
    const env = (profile?.["env"] ?? {}) as Json;
    if (profile?.["channel"] !== profileName(tenant.slug) || env["XOS_TENANT"] !== tenant.slug)
      problems.push(`eas.json has no build profile ${profileName(tenant.slug)} for ${file}`);
  }
  for (const name of Object.keys(build)) {
    if (name.startsWith("tenant-") && !slugs.has(name.slice("tenant-".length)))
      problems.push(`eas.json build profile ${name} has no tenant definition`);
  }
  return problems;
}

function main(argv: readonly string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Json;
  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  if (argv[2] === "--check") {
    const dir = join(root, "tenants");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    const problems = checkTenants(
      readJson("eas.json"),
      files.map((file) => ({ file, value: readJson(`tenants/${file}`) })),
    );
    for (const p of problems) console.error(p);
    return problems.length > 0 ? 1 : 0;
  }
  const args = parseArgs(argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }
  const tenant = tenantDefinition(args);
  const problems = tenantProblems(tenant);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    return 1;
  }
  writeJson(`tenants/${tenant.slug}.json`, tenant);
  writeJson(tenant.storeConfig, tenantStoreConfig(readJson("store/store.config.json"), tenant));
  writeJson("eas.json", withTenantProfiles(readJson("eas.json"), tenant));
  console.log(
    [
      `Wrote tenants/${tenant.slug}.json, ${tenant.storeConfig} and the ${profileName(tenant.slug)} profiles.`,
      "Owner steps before the first build:",
      `- put the tenant's 1024 x 1024 icon (PNG, no transparency) at ${tenant.icon} and its splash at ${tenant.splash}`,
      `- create the tenant's EAS project and put its id in tenants/${tenant.slug}.json easProjectId`,
      `- register ${tenant.bundleIdentifier}, ${tenant.bundleIdentifier}.clock-activity and group.${tenant.bundleIdentifier}`,
      `- fill submit.${profileName(tenant.slug)} in eas.json and the listing in ${tenant.storeConfig}`,
      `- build: npx eas build --profile ${profileName(tenant.slug)} --platform all`,
    ].join("\n"),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
