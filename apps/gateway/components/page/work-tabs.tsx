import { childTabLinks, SectionTabs } from "@/components/page/page";
import type { GatewayContext } from "@/lib/shell/context";
import { childTabs } from "@/lib/shell/nav-model";
import { sitemap } from "@/lib/shell/sitemap";
import type { Translate } from "@/lib/shell/translate";

/** The page tabs under a destination (Work, Money), from the sitemap for the viewer's standing. */
export function DestinationTabs({
  ctx,
  destination,
  active,
  t,
}: {
  ctx: GatewayContext;
  destination: string;
  active: string;
  t: Translate;
}) {
  return (
    <SectionTabs
      label={t("gateway.shell.pageTabs")}
      tabs={childTabLinks(childTabs(sitemap, destination, ctx.nav), t)}
      active={active}
    />
  );
}
