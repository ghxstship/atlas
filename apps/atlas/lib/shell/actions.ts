"use server";

import { cookies } from "next/headers";
import { isLocale } from "@xos/i18n/locales";
import { z } from "zod";
import { LOCALE_COOKIE, selectableLocales } from "@/i18n/negotiate";
import { env } from "@/lib/env";
import { THEME_COOKIE, THEMES } from "@/lib/theme";
import { setPersonalSetting } from "@xos/data/settings";
import { getMyOrganizations, getViewer } from "./context";
import { WORKSPACE_COOKIE } from "./workspace";
import { devicePreference } from "./org-settings";

/**
 * Device preferences set from the shell: language, theme and the workspace filter, kept in httpOnly
 * SameSite=Lax cookies for this device. Language and theme are also saved as the person's own
 * settings (Section 4.5.6), so the other shells follow them. Other tabs pick them up through
 * BroadcastChannel. The context switcher action binds the session to the chosen org.
 */
const YEAR = 60 * 60 * 24 * 365;

async function setPreference(name: string, value: string): Promise<void> {
  (await cookies()).set(name, value, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: env().ATLAS_SITE_URL.startsWith("https:"),
    maxAge: YEAR,
  });
}

/** Keeps a device preference as the person's own setting too, so Gateway and Compass follow it. */
async function rememberPersonally(key: string, value: string): Promise<void> {
  const viewer = await getViewer();
  if (!viewer?.person) return;
  const saved = await setPersonalSetting(viewer.db, { key, value });
  if (!saved.ok) throw new Error(`Cannot save ${key}: ${JSON.stringify(saved.error)}`);
}

export async function setLocale(locale: string): Promise<void> {
  const allowed = selectableLocales(process.env.NODE_ENV === "production") as string[];
  const chosen = z.enum(allowed as [string, ...string[]]).parse(locale);
  await setPreference(LOCALE_COOKIE, chosen);
  // Launch and Beta locales (ADR 0053) are saved for the other shells; a pseudo-locale stays on this device.
  if (isLocale(chosen)) await rememberPersonally("locale.language", chosen);
}

export async function setTheme(theme: string): Promise<void> {
  const chosen = z.enum(THEMES).parse(theme);
  await setPreference(THEME_COOKIE, chosen);
  await rememberPersonally("me.theme", chosen);
}

/**
 * A theme or language saved on a settings page (me.theme, locale.language) applies on this device at once,
 * as the shell's own pickers do. A theme of System keeps the device's current one.
 */
export async function applyDevicePreference(key: string, value: string): Promise<void> {
  const locales = selectableLocales(process.env.NODE_ENV === "production") as string[];
  const device = devicePreference(key, value, THEMES, locales);
  if (device)
    await setPreference(device.cookie === "theme" ? THEME_COOKIE : LOCALE_COOKIE, device.value);
}

/**
 * The context switcher (ADR 0007 item 1): records the chosen org with app.set_active_org (A04R's
 * 0920), then refreshes the session so the access token's org_id claim names it. Returns the
 * org's slug, or null when the person no longer belongs to it.
 */
export async function selectOrganization(slug: string): Promise<string | null> {
  const viewer = await getViewer();
  if (!viewer) return null;
  const org = (await getMyOrganizations()).find((o) => o.slug === slug);
  if (!org) return null;
  const { error } = await viewer.db.rpc("set_active_org", { p_org_id: org.id });
  if (error) throw new Error(`Cannot select the organization: ${error.message}`);
  const refreshed = await viewer.db.auth.refreshSession();
  if (refreshed.error) throw new Error(`Cannot refresh the session: ${refreshed.error.message}`);
  return org.slug;
}

export async function setWorkspace(slug: string): Promise<void> {
  if (slug === "") {
    (await cookies()).delete(WORKSPACE_COOKIE);
    return;
  }
  await setPreference(
    WORKSPACE_COOKIE,
    z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .parse(slug),
  );
}
