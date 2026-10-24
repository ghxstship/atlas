import { getSubscription } from "@xos/data";
import { isProviderCode } from "@xos/integrations";
import {
  listDeadLetters,
  listInboundSecretConnections,
  listWarehouseDeliveries,
  listWarehouseDestinations,
  listWarehouseProviders,
  listWithheldColumns,
} from "@xos/data/warehouse";
import { InlineAlert } from "@/components/ui";
import {
  AddWarehouseDestinationForm,
  InboundSecretForm,
  RetryDeadLetterForm,
  WarehouseCredentialForm,
  WarehouseDestinationActions,
} from "@/components/integrations/warehouse-forms";
import { docsUrl } from "@/lib/docs-site";
import { env } from "@/lib/env";
import { getFormatters } from "@/lib/platform/format";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A83's panels on Settings, Integrations (RRR-128):
 *   Warehouse delivery (Section 4.6.4, Enterprise; finding A65-029): destinations with their Vault credential,
 *     Deliver now, pause and delete, recent deliveries, and the columns a delivery never writes.
 *   Provider webhooks (finding A65-013): webhooks that failed for good, sent back with a reason, and the secrets
 *     Teams, Google Calendar and Microsoft Graph sign a connection's webhooks with.
 * Each panel reads with the viewer's client, so row level security decides what appears; the RPCs decide every
 * change. Copy is the `platform` namespace (warehouse, inbound) and provider names the `integrations` namespace.
 */

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

async function WarehousePanel({ ctx }: SettingsPanelProps) {
  const canSchedule = ctx.capabilities.has("reports.schedule.write");
  if (!canSchedule && !ctx.capabilities.has("org.integrations.manage")) return null;
  const { t, dateTime, number } = await getFormatters(ctx);
  const subscription = await getSubscription(ctx.viewer.db, ctx.org.id);
  const docs = docsUrl(env(), "/en-US/guides/warehouse-delivery");
  const heading = (
    <Heading
      id="warehouse-delivery"
      title={t("warehouse.title")}
      description={t("warehouse.description")}
    />
  );
  if (subscription.ok && subscription.data.planCode !== "enterprise") {
    return (
      <section aria-labelledby="warehouse-delivery" className="flex flex-col gap-12">
        {heading}
        <InlineAlert tone="info">{t("warehouse.enterpriseOnly")}</InlineAlert>
      </section>
    );
  }
  const [providers, destinations, deliveries, withheld, zone] = await Promise.all([
    listWarehouseProviders(ctx.viewer.db),
    listWarehouseDestinations(ctx.viewer.db, ctx.org.id),
    listWarehouseDeliveries(ctx.viewer.db, ctx.org.id),
    listWithheldColumns(ctx.viewer.db),
    getOrgTimeZone(ctx),
  ]);
  // Nightly is the org's night: the hour is on the org's own locale.time_zone clock, the row the scheduler
  // reads (private.org_time_zone, 1401), never a member's own zone, which resolved settings would rank first.
  if (!subscription.ok || !providers.ok || !destinations.ok || !deliveries.ok || !withheld.ok) {
    return (
      <section aria-labelledby="warehouse-delivery" className="flex flex-col gap-12">
        {heading}
        <InlineAlert tone="danger">{t("warehouse.loadError")}</InlineAlert>
      </section>
    );
  }
  const nameOf = new Map(destinations.data.map((d) => [d.id, d.displayName]));
  return (
    <section aria-labelledby="warehouse-delivery" className="flex flex-col gap-16">
      {heading}
      {!canSchedule ? <InlineAlert tone="info">{t("warehouse.readOnly")}</InlineAlert> : null}
      {destinations.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("warehouse.empty")}</p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-12 p-0"
          aria-label={t("warehouse.destinations")}
        >
          {destinations.data.map((d) => (
            <li
              key={d.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">{d.displayName}</span>
                <span className="text-text-12 text-text-secondary">
                  {t(`warehouse.states.${d.state}`)}
                </span>
              </div>
              <p className="m-0 text-text-13">
                {t("warehouse.line", {
                  provider: d.provider,
                  bucket: d.bucketName,
                  format: d.fileFormat,
                  hour: String(d.deliveryHour).padStart(2, "0"),
                  zone,
                })}
              </p>
              <p className="m-0 text-text-12 text-text-secondary">
                {d.lastDeliveredAt
                  ? t("warehouse.last", { when: dateTime(d.lastDeliveredAt) })
                  : t("warehouse.never")}
                {d.nextDeliveryAt && d.state === "Active"
                  ? ` ${t("warehouse.next", { when: dateTime(d.nextDeliveryAt) })}`
                  : ""}
              </p>
              {d.includeConfidential ? (
                <p className="m-0 text-text-12 text-warning-text">
                  {t("warehouse.confidentialOn")}
                </p>
              ) : null}
              {d.lastErrorMessage ? (
                <InlineAlert tone="warning">
                  {t("warehouse.lastError", { error: d.lastErrorMessage })}
                </InlineAlert>
              ) : null}
              <p className="m-0 text-text-12 text-text-secondary">
                {d.credentialStoredAt
                  ? t("warehouse.credential.stored", { when: dateTime(d.credentialStoredAt) })
                  : t("warehouse.credential.missing")}
              </p>
              {canSchedule ? (
                <>
                  <WarehouseCredentialForm
                    org={ctx.org.slug}
                    destination={d.id}
                    name={d.displayName}
                  />
                  <WarehouseDestinationActions
                    org={ctx.org.slug}
                    destination={d.id}
                    name={d.displayName}
                    paused={d.state === "Paused"}
                  />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canSchedule ? (
        <div className="flex max-w-layout-form flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t("warehouse.add.heading")}</h3>
          <AddWarehouseDestinationForm
            org={ctx.org.slug}
            providers={providers.data.filter((p) => p.available).map((p) => p.provider)}
            unavailable={providers.data.filter((p) => !p.available).map((p) => p.provider)}
            canIncludeConfidential={ctx.capabilities.has("data.export.confidential")}
            timeZone={zone}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-8">
        <h3 className="m-0 text-text-14 font-semibold">{t("warehouse.deliveries.title")}</h3>
        {deliveries.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("warehouse.deliveries.empty")}</p>
        ) : (
          <div
            role="region"
            aria-label={t("warehouse.deliveries.title")}
            tabIndex={0}
            className="overflow-x-auto"
          >
            <table className="w-full border-collapse text-text-13">
              <caption className="sr-only">{t("warehouse.deliveries.title")}</caption>
              <thead>
                <tr className="text-text-12 text-text-secondary">
                  {(
                    ["started", "state", "trigger", "tables", "rows", "withheld", "error"] as const
                  ).map((key) => (
                    <th key={key} scope="col" className="py-6 pe-12 text-start font-medium">
                      {t(`warehouse.deliveries.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((w) => (
                  <tr key={w.id} className="border-t border-border-subtle">
                    <th scope="row" className="py-6 pe-12 text-start font-normal">
                      {dateTime(w.createdAt)}
                      <span className="block text-text-12 text-text-tertiary">
                        {nameOf.get(w.destinationId) ?? ""}
                      </span>
                    </th>
                    <td className="py-6 pe-12">{t(`warehouse.deliveryStates.${w.state}`)}</td>
                    <td className="py-6 pe-12">
                      {w.manual
                        ? t("warehouse.deliveries.manual")
                        : t("warehouse.deliveries.nightly")}
                    </td>
                    <td className="py-6 pe-12 tabular-nums">{number(w.tablesDelivered)}</td>
                    <td className="py-6 pe-12 tabular-nums">{number(w.rowsDelivered)}</td>
                    <td className="py-6 pe-12 tabular-nums">{number(w.columnsWithheld)}</td>
                    <td className="py-6 text-text-12">{w.errorMessage ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-8">
        <h3 className="m-0 text-text-14 font-semibold">{t("warehouse.withheld.title")}</h3>
        <p className="m-0 text-text-13 text-text-secondary">{t("warehouse.withheld.intro")}</p>
        <ul
          className="m-0 flex list-none flex-col gap-2 p-0 text-text-12"
          aria-label={t("warehouse.withheld.title")}
        >
          {withheld.data.map((c) => (
            <li key={`${c.tableKey}.${c.columnName}`}>
              {t(
                c.classification === "Restricted"
                  ? "warehouse.withheld.restricted"
                  : "warehouse.withheld.confidential",
                {
                  table: c.tableKey,
                  column: c.columnName,
                },
              )}
            </li>
          ))}
        </ul>
        {docs ? (
          <a href={docs} className="text-text-13 text-accent-text underline">
            {t("warehouse.docs")}
          </a>
        ) : null}
      </div>
    </section>
  );
}

async function ProviderWebhooksPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.integrations.manage")) return null;
  const [{ t, dateTime }, ti, letters, secrets] = await Promise.all([
    getFormatters(ctx),
    getTranslate(),
    listDeadLetters(ctx.viewer.db, ctx.org.id),
    listInboundSecretConnections(ctx.viewer.db, ctx.org.id),
  ]);
  const provider = (code: string) =>
    isProviderCode(code) ? ti(`integrations.providers.${code}`) : code;
  const base = `${env().SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/integration-inbound`;
  return (
    <section aria-labelledby="provider-webhooks" className="flex flex-col gap-16">
      <Heading
        id="provider-webhooks"
        title={t("inbound.title")}
        description={t("inbound.description")}
      />
      {!letters.ok || !secrets.ok ? (
        <InlineAlert tone="danger">{t("inbound.loadError")}</InlineAlert>
      ) : (
        <>
          {letters.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("inbound.empty")}</p>
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-12 p-0"
              aria-label={t("inbound.caption")}
            >
              {letters.data.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                >
                  <p className="m-0 text-text-13">
                    {t("inbound.line", {
                      provider: provider(e.providerCode),
                      kind: t(`inbound.kinds.${e.kind}`),
                      when: dateTime(e.receivedAt),
                      attempts: e.attempts,
                    })}
                  </p>
                  {e.errorMessage ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("inbound.error", { error: e.errorMessage })}
                    </p>
                  ) : null}
                  <RetryDeadLetterForm
                    org={ctx.org.slug}
                    event={e.id}
                    provider={provider(e.providerCode)}
                  />
                </li>
              ))}
            </ul>
          )}
          {secrets.data.length > 0 ? (
            <div className="flex flex-col gap-8">
              <h3 className="m-0 text-text-14 font-semibold">{t("inbound.secrets.title")}</h3>
              <p className="m-0 text-text-13 text-text-secondary">{t("inbound.secrets.intro")}</p>
              <ul
                className="m-0 flex list-none flex-col gap-12 p-0"
                aria-label={t("inbound.secrets.title")}
              >
                {secrets.data.map((c) => (
                  <li
                    key={c.connectionId}
                    className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                  >
                    <span className="text-text-13 font-medium">
                      {t("inbound.secrets.connection", {
                        name: c.displayName,
                        provider: provider(c.providerCode),
                      })}
                    </span>
                    <span className="break-all font-mono text-text-12 text-text-secondary">
                      {t("inbound.secrets.endpoint", {
                        url: `${base}/${c.providerCode}/${c.connectionId}`,
                      })}
                    </span>
                    <span className="text-text-12 text-text-secondary">
                      {c.storedAt
                        ? t("inbound.secrets.stored", { when: dateTime(c.storedAt) })
                        : t("inbound.secrets.missing")}
                    </span>
                    <InboundSecretForm
                      org={ctx.org.slug}
                      connection={c.connectionId}
                      name={c.displayName}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.integrations", order: 20, Panel: ProviderWebhooksPanel },
  { node: "settings.integrations", order: 30, Panel: WarehousePanel },
];
