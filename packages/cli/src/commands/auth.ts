/**
 * `xos auth login | status | logout` and `xos org list | use | current`.
 *
 * Keys are read from `XOS_API_KEY` or standard input, never from a flag, so they stay out of
 * shell history and process listings.
 */
import { parseArgs } from "node:util";
import type { Me } from "@xos/sdk";
import type { Config } from "../config.ts";
import { assertProfileName, writeConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { UsageError } from "../io.ts";
import { render } from "../output.ts";

const DEFAULT_PROFILE = "default";

async function readKey(ctx: Context, fromStdin: boolean): Promise<string> {
  const fromEnv = ctx.io.env["XOS_API_KEY"];
  if (fromStdin) {
    const key = (await ctx.io.readStdin()).trim();
    if (!key)
      throw new UsageError(
        "Standard input was empty; pipe the API key into `xos auth login --key-stdin`.",
      );
    return key;
  }
  if (fromEnv) return fromEnv;
  throw new UsageError("Provide the API key through XOS_API_KEY or pipe it with --key-stdin.");
}

export async function login(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { "key-stdin": { type: "boolean", default: false } },
  });
  const name = ctx.flags.profile ?? DEFAULT_PROFILE;
  assertProfileName(name);
  const baseUrl = ctx.flags.baseUrl ?? ctx.io.env["XOS_BASE_URL"];
  if (!baseUrl)
    throw new UsageError("Pass --base-url, for example https://atlas.example.com/api/v1.");
  const apiKey = await readKey(ctx, values["key-stdin"]);
  // Verify the key before storing it; a bad key raises XosAuthenticationError.
  const me: Me = (await ctx.client({ baseUrl, apiKey }).me.get()).data;
  const config = ctx.config();
  const next: Config = {
    defaultProfile: config.defaultProfile ?? name,
    profiles: {
      ...config.profiles,
      [name]: {
        baseUrl,
        apiKey,
        personId: me.person_id,
        organizationId: me.active_organization_id,
      },
    },
  };
  writeConfig(ctx.configFile, next);
  ctx.io.stderr(
    `Signed in as person ${me.person_id} in organization ${me.active_organization_id ?? "none"}; saved as profile "${name}".\n`,
  );
  return 0;
}

export async function status(ctx: Context): Promise<number> {
  const creds = ctx.credentials();
  const me = (await ctx.client(creds).me.get()).data;
  render(ctx.io, ctx.format, {
    profile: creds.profileName,
    base_url: creds.baseUrl,
    person_id: me.person_id,
    active_organization_id: me.active_organization_id,
    membership_count: me.membership_count,
    engagement_count: me.engagement_count,
  });
  return 0;
}

export function logout(ctx: Context): number {
  const config = ctx.config();
  const name = ctx.flags.profile ?? config.defaultProfile;
  if (!name || !config.profiles[name]) throw new UsageError("No saved profile to sign out of.");
  const profiles = Object.fromEntries(Object.entries(config.profiles).filter(([k]) => k !== name));
  const remaining = Object.keys(profiles);
  writeConfig(ctx.configFile, {
    defaultProfile: config.defaultProfile === name ? (remaining[0] ?? null) : config.defaultProfile,
    profiles,
  });
  ctx.io.stderr(
    `Removed profile "${name}". The key itself stays valid; revoke it in Settings > API keys.\n`,
  );
  return 0;
}

export async function orgList(ctx: Context, argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { remote: { type: "boolean", default: false } },
  });
  if (values.remote) {
    const rows = [];
    for await (const org of ctx.client().organizations.listAll()) rows.push(org);
    render(ctx.io, ctx.format, rows);
    return 0;
  }
  const config = ctx.config();
  const rows = Object.entries(config.profiles).map(([name, p]) => ({
    profile: name,
    current: name === config.defaultProfile,
    organization_id: p.organizationId,
    base_url: p.baseUrl,
  }));
  if (rows.length === 0 && ctx.format === "table") {
    ctx.io.stdout(
      "No profiles yet. Run `xos auth login --profile <name>` once per organization.\n",
    );
    return 0;
  }
  render(ctx.io, ctx.format, rows);
  return 0;
}

export function orgUse(ctx: Context, argv: readonly string[]): number {
  const name = argv[0];
  if (!name) throw new UsageError("Name the profile to use: `xos org use <profile>`.");
  const config = ctx.config();
  const profile = config.profiles[name];
  if (!profile)
    throw new UsageError(`No profile named "${name}". Run \`xos org list\` to see them.`);
  writeConfig(ctx.configFile, { ...config, defaultProfile: name });
  ctx.io.stderr(
    `Now using profile "${name}" (organization ${profile.organizationId ?? "none"}).\n`,
  );
  return 0;
}

export function orgCurrent(ctx: Context): number {
  const creds = ctx.credentials();
  const profile = creds.profileName ? ctx.config().profiles[creds.profileName] : undefined;
  render(ctx.io, ctx.format, {
    profile: creds.profileName,
    organization_id: profile?.organizationId ?? null,
    base_url: creds.baseUrl,
  });
  return 0;
}
