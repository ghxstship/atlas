import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";
import appIcon from "@xos/ui/brand/app-icon.svg";
import { manifestColors } from "@xos/ui/pwa";
import { brandStyle } from "@/lib/brand/brand";
import { getRequestFacts } from "@/lib/shell/context";

/**
 * The web app manifest (Section 4.10, A65-023, ADR 0052). Gateway installs as a standalone app on the whole origin.
 * On an org's custom domain it wears that org's brand (Section 4.4.7): its name, its app icon (served on this origin
 * by /brand/app-icon) and its accent when the accent passes the contrast gate. Everywhere else, and for anything the
 * org has not set, the platform brand: the platform app icon and the light canvas from the tokens.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [shell, nav, facts] = await Promise.all([
    getTranslations("shell.gateway"),
    getTranslations("nav.gateway.primary"),
    getRequestFacts(),
  ]);
  const org = facts.brand.kind === "org" ? facts.brand.org : null;
  const name = org?.name ?? shell("name");
  const accent = brandStyle(facts.brand)["--color-accent-default"];
  const colors = manifestColors("light");
  return {
    id: "/",
    name,
    short_name: name.slice(0, 30),
    description: shell("tagline"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: colors.background_color,
    theme_color: accent ?? colors.theme_color,
    icons: org?.appIconPath
      ? [{ src: "/brand/app-icon", sizes: "1024x1024", type: "image/png", purpose: "any" }]
      : [{ src: appIcon.src, sizes: "any", type: "image/svg+xml", purpose: "any" }],
    shortcuts: [
      { name: nav("work"), url: "/work" },
      { name: nav("money"), url: "/money" },
      { name: nav("explore"), url: "/explore" },
    ],
  };
}
