import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";
import appIcon from "@xos/ui/brand/app-icon.svg";
import { manifestColors } from "@xos/ui/pwa";

/**
 * The web app manifest (Section 4.10, A65-023, ADR 0052): Atlas installs as a standalone app on the whole origin,
 * with the platform brand's app icon (packages/ui/src/brand/defaults, replaced there when the marks are set), the
 * dark canvas of the default theme from the tokens, and shortcuts the entry route resolves to the org used last.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [shell, nav] = await Promise.all([
    getTranslations("shell.atlas"),
    getTranslations("nav.atlas.items"),
  ]);
  return {
    id: "/",
    name: shell("name"),
    short_name: shell("name"),
    description: shell("tagline"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    ...manifestColors("dark"),
    icons: [{ src: appIcon.src, sizes: "any", type: "image/svg+xml", purpose: "any" }],
    shortcuts: [
      { name: nav("inbox"), url: "/?open=inbox" },
      { name: nav("myWork"), url: "/?open=my-work" },
      { name: nav("projects"), url: "/?open=projects" },
    ],
  };
}
