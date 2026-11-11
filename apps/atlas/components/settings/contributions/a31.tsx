import { getSubscription } from "@xos/data";
import { getHelpState } from "@xos/data/help";
import { listSupportTickets } from "@xos/data/support";
import { myMembershipId } from "@xos/data/views";
import { flattenRoutes } from "@xos/ia";
import { HELP_CONTENT } from "@/help/content.generated";
import { InlineAlert } from "@/components/ui";
import { PlatformContact } from "@/components/support/platform-contact";
import { SupportRequests } from "@/components/support/support-requests";
import { ToursAndTips } from "@/components/support/tours-tips";
import { gatewayUrl } from "@/lib/gateway-url";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { platformChannel } from "@/lib/support/terms";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A31's settings panels (Section 11.16, ADR 0021 item 7):
 *   Settings, Help and support   every support request of the org for those who answer support,
 *                                and contacting the platform team on plans that include it
 *   Me, Account                  the person's own support requests
 *   Me, Preferences              guided tours (replayable) and contextual tips (resettable)
 * Each reads with the viewer's client, so row level security decides what appears.
 */

async function membershipOf({ ctx }: SettingsPanelProps): Promise<string | null> {
  if (!ctx.viewer.person) return null;
  const result = await myMembershipId(ctx.viewer.db, {
    orgId: ctx.org.id,
    personId: ctx.viewer.person.id,
  });
  return result.ok ? result.data : null;
}

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

async function OrgSupportPanel(props: SettingsPanelProps) {
  const { ctx } = props;
  const t = await getTranslate();
  const canAnswer = ctx.capabilities.has("org.help.write");
  const [tickets, subscription, membership] = await Promise.all([
    listSupportTickets(ctx.viewer.db, { orgId: ctx.org.id }),
    getSubscription(ctx.viewer.db, ctx.org.id),
    membershipOf(props),
  ]);
  return (
    <section aria-labelledby="support-requests-heading" className="flex flex-col gap-12">
      <Heading
        id="support-requests-heading"
        title={t("support.org.title")}
        description={t("support.org.description")}
      />
      {canAnswer ? (
        <PlatformContact
          org={ctx.org.slug}
          platformChannel={platformChannel(subscription.ok ? subscription.data.planCode : null)}
        />
      ) : (
        <InlineAlert tone="info">{t("support.org.readOnly")}</InlineAlert>
      )}
      {tickets.ok ? (
        <SupportRequests
          org={ctx.org.slug}
          tickets={tickets.data}
          viewerMembershipId={membership}
          canAnswer={canAnswer}
          showRequester
          showFilter
          emptyText={t("support.org.empty")}
        />
      ) : (
        <InlineAlert tone="danger">{t("support.errors.loadFailed")}</InlineAlert>
      )}
    </section>
  );
}

async function MySupportPanel(props: SettingsPanelProps) {
  const { ctx } = props;
  const t = await getTranslate();
  const membership = await membershipOf(props);
  const tickets = membership
    ? await listSupportTickets(ctx.viewer.db, {
        orgId: ctx.org.id,
        requesterMembershipId: membership,
      })
    : null;
  return (
    <section aria-labelledby="my-support-heading" className="flex flex-col gap-12">
      <Heading
        id="my-support-heading"
        title={t("support.mine.title")}
        description={t("support.mine.description")}
      />
      {tickets?.ok ? (
        <SupportRequests
          org={ctx.org.slug}
          tickets={tickets.data}
          viewerMembershipId={membership}
          canAnswer={false}
          showRequester={false}
          showFilter={false}
          emptyText={t("support.mine.empty")}
        />
      ) : (
        <InlineAlert tone="danger">{t("support.errors.loadFailed")}</InlineAlert>
      )}
    </section>
  );
}

/** The page a tour is replayed on: its first page with a route that needs only the org. */
function replayHref(nodes: readonly string[], org: string, key: string): string | null {
  for (const pattern of nodes) {
    if (pattern === "*") continue;
    const id = pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern;
    if (!flattenRoutes(sitemap).some((r) => r.id === id)) continue;
    const href = nodeHref(id, { org });
    if (href) return `${href}?tour=${encodeURIComponent(key)}`;
  }
  return null;
}

async function ToursTipsPanel(props: SettingsPanelProps) {
  const { ctx } = props;
  const t = await getTranslate();
  const membership = await membershipOf(props);
  const state = membership ? await getHelpState(ctx.viewer.db, membership) : null;
  if (!state?.ok) {
    return <InlineAlert tone="danger">{t("help.loadFailed")}</InlineAlert>;
  }
  return (
    <ToursAndTips
      org={ctx.org.slug}
      tours={HELP_CONTENT.tours.map((tour) => ({
        key: tour.key,
        state: state.data.tours.find((x) => x.tourKey === tour.key)?.state ?? null,
        href: replayHref(tour.nodes, ctx.org.slug, tour.key),
      }))}
      dismissedTips={state.data.dismissedTips.length}
    />
  );
}

/**
 * Me, Account: the XOS account itself (name, sign-in methods, deletion) lives in Gateway (Section 4.5.8), so Atlas says
 * so and links there instead of promising controls it does not have (crawl 4.9).
 */
async function AccountInGatewayPanel(_: SettingsPanelProps) {
  const t = await getTranslate();
  return (
    <section
      aria-labelledby="account-in-gateway"
      className="flex flex-col gap-8"
      data-testid="account-in-gateway"
    >
      <Heading
        id="account-in-gateway"
        title={t("settings.account.gatewayTitle")}
        description={t("settings.account.gatewayBody")}
      />
      <a
        href={gatewayUrl("/settings/account")}
        className="text-text-13 font-medium text-accent-text underline"
      >
        {t("settings.account.gatewayLink")}
      </a>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.account", order: 0, Panel: AccountInGatewayPanel },
  { node: "settings.help-and-support", order: 100, Panel: OrgSupportPanel },
  { node: "me.account", order: 100, Panel: MySupportPanel },
  { node: "me.preferences", order: 100, Panel: ToursTipsPanel },
];
