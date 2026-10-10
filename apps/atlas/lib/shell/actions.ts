"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { LOCALE_COOKIE, selectableLocales } from "@/i18n/negotiate";
import { THEME_COOKIE, THEMES } from "@/lib/theme";
import { WORKSPACE_COOKIE } from "./workspace";

/**
 * Device preferences set from the shell: language, theme and the workspace filter. They live in
 * cookies until personal preferences (Section 4.5.6, A30) store them per person; httpOnly and
 * SameSite=Lax like every Atlas cookie. Other tabs pick them up through BroadcastChannel.
 */
const YEAR = 60 * 60 * 24 * 365;

async function setPreference(name: string, value: string): Promise<void> {
  (await cookies()).set(name, value, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: YEAR,
  });
}

export async function setLocale(locale: string): Promise<void> {
  const allowed = selectableLocales(process.env.NODE_ENV === "production") as string[];
  await setPreference(LOCALE_COOKIE, z.enum(allowed as [string, ...string[]]).parse(locale));
}

export async function setTheme(theme: string): Promise<void> {
  await setPreference(THEME_COOKIE, z.enum(THEMES).parse(theme));
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
