import { can } from "@xos/data/console";
import {
  listOrgsOutsideTerritories,
  listPriceBookCurrencies,
  listTerritories,
  listTerritoryExceptions,
} from "@xos/data/console-territories";
import { countryName, countryOptions } from "@xos/i18n/formats";
import { locales } from "@xos/i18n/locales";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { getLocale } from "next-intl/server";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import { Empty, PageHeader, Panel, Section, Table } from "@/components/page";
import { TerritoryForm } from "@/components/territory-form";
import { Input, Select } from "@/components/ui";
import {
  grantTerritoryExceptionAction,
  revokeTerritoryExceptionAction,
  setTerritoryOfferedAction,
} from "@/lib/actions/territories";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("territories.title") };
}

/**
 * Where XOS is offered (ADR 0160): the one place an operator opens or closes a territory, and records an exception for a
 * signed contract. Opening one changes signup at once, and prices and languages usually within a minute and at most about
 * 11, with no code change.
 */
export default async function TerritoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const ctx = await requirePermission("tenants.read");
  const { t, instant } = await getConsoleFormat();
  const locale = await getLocale();
  const [{ edit }, territories, priceBook, exceptions, outside] = await Promise.all([
    searchParams,
    listTerritories(ctx.db),
    listPriceBookCurrencies(ctx.db),
    listTerritoryExceptions(ctx.db),
    listOrgsOutsideTerritories(ctx.db),
  ]);
  const write = can(ctx.operator, "territories.write");
  const name = (code: string) => countryName(code, locale);
  const countries = countryOptions(locale);
  const editing = territories.ok
    ? (territories.data.find((territory) => territory.code === edit) ?? null)
    : null;
  return (
    <>
      <PageHeader title={t("territories.title")} intro={t("territories.intro")} />
      <Section id="territories-list" title={t("territories.list")}>
        {!territories.ok ? (
          <Empty>{t("common.loadError")}</Empty>
        ) : (
          <Table
            caption={t("territories.list")}
            testId="territories"
            columns={[
              t("territories.territory"),
              t("territories.countries"),
              t("territories.currencies"),
              t("territories.languages"),
              t("territories.state"),
              t("territories.lastChange"),
            ]}
            rows={territories.data.map((territory) => ({
              key: territory.code,
              cells: [
                <span key="name" className="flex flex-col gap-4">
                  <code className="font-mono">{territory.code}</code>
                  <span className="text-text-12 text-text-secondary">{territory.nameEn}</span>
                  {write ? (
                    <NextLink
                      href={`/territories?edit=${territory.code}#territories-add` as Route}
                      aria-label={t("territories.editTitle", { code: territory.code })}
                      className="text-accent-text underline"
                    >
                      {t("territories.edit")}
                    </NextLink>
                  ) : null}
                </span>,
                territory.countries.join(", "),
                territory.currencies.join(", ") || t("common.none"),
                territory.locales.join(", ") || t("common.none"),
                <span key="state" className="flex flex-col gap-8">
                  <span>{territory.offered ? t("territories.open") : t("territories.closed")}</span>
                  {write ? (
                    <ActionForm
                      action={setTerritoryOfferedAction}
                      hidden={{ code: territory.code, offered: territory.offered ? "off" : "on" }}
                      submitLabel={
                        territory.offered ? t("territories.close") : t("territories.openIt")
                      }
                      successLabel={t("common.saved")}
                      variant={territory.offered ? "danger" : "secondary"}
                      label={t("territories.changeFor", { code: territory.code })}
                    >
                      <ReasonField t={t} id={`territory-${territory.code}-reason`} />
                    </ActionForm>
                  ) : null}
                </span>,
                <span key="change" className="flex flex-col gap-4">
                  <span>{instant(territory.changedAt)}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t("territories.changedBy", {
                      name: territory.changedByName ?? t("activity.platform"),
                      reason: territory.changeReason,
                    })}
                  </span>
                </span>,
              ],
            }))}
          />
        )}
      </Section>
      {write ? (
        <Section
          id="territories-add"
          title={
            editing ? t("territories.editTitle", { code: editing.code }) : t("territories.add")
          }
        >
          {editing ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("territories.editIntro")} {editing.offered ? t("territories.editOpen") : null}{" "}
              <NextLink
                href={"/territories#territories-add" as Route}
                className="text-accent-text underline"
              >
                {t("territories.addInstead")}
              </NextLink>
            </p>
          ) : null}
          {territories.ok && priceBook.ok ? (
            <Panel>
              <TerritoryForm
                key={editing?.code ?? "new"}
                countries={countries}
                currencies={[...new Set([...priceBook.data, ...(editing?.currencies ?? [])])].map(
                  (c) => ({ value: c, label: c }),
                )}
                locales={locales.map((l) => ({ value: l, label: l }))}
                territory={editing}
                version={editing ? editing.changedAt : String(territories.data.length)}
              />
            </Panel>
          ) : (
            <Empty>{t("common.loadError")}</Empty>
          )}
        </Section>
      ) : null}
      <Section id="territories-exceptions" title={t("territories.exceptions")}>
        <p className="m-0 text-text-13 text-text-secondary">{t("territories.exceptionsIntro")}</p>
        {!exceptions.ok ? (
          <Empty>{t("common.loadError")}</Empty>
        ) : exceptions.data.length === 0 ? (
          <Empty>{t("territories.exceptionsNone")}</Empty>
        ) : (
          <Table
            caption={t("territories.exceptions")}
            testId="territory-exceptions"
            columns={[
              t("territories.ownerEmail"),
              t("territories.country"),
              t("territories.contract"),
              t("territories.exceptionReason"),
              t("territories.state"),
            ]}
            rows={exceptions.data.map((e) => ({
              key: e.id,
              cells: [
                e.ownerEmail,
                name(e.countryCode),
                t("territories.contractOn", {
                  reference: e.contractReference,
                  date: e.contractSignedOn,
                }),
                t("territories.grantedBy", {
                  name: e.grantedByName ?? t("activity.platform"),
                  when: instant(e.grantedAt),
                  reason: e.reason,
                }),
                e.revokedAt ? (
                  t("territories.exceptionRevoked", {
                    when: instant(e.revokedAt),
                    reason: e.revokeReason ?? "",
                  })
                ) : e.usedAt ? (
                  e.orgId ? (
                    <NextLink
                      key="org"
                      href={`/tenants/${e.orgId}` as Route}
                      className="text-accent-text underline"
                    >
                      {t("territories.exceptionUsed", { org: e.orgName ?? "" })}
                    </NextLink>
                  ) : (
                    t("territories.exceptionUsedGone")
                  )
                ) : write ? (
                  <ActionForm
                    key="revoke"
                    action={revokeTerritoryExceptionAction}
                    hidden={{ id: e.id }}
                    submitLabel={t("territories.withdraw")}
                    successLabel={t("common.saved")}
                    variant="danger"
                    label={t("territories.withdrawFor", { email: e.ownerEmail })}
                  >
                    <ReasonField t={t} id={`exception-${e.id}-reason`} />
                  </ActionForm>
                ) : (
                  t("territories.exceptionOpen")
                ),
              ],
            }))}
          />
        )}
        {write ? (
          <Panel>
            <ActionForm
              action={grantTerritoryExceptionAction}
              submitLabel={t("territories.grant")}
              successLabel={t("territories.granted")}
              label={t("territories.grantTitle")}
              variant="secondary"
              testId="territory-exception-form"
            >
              <Input
                id="exception-email"
                name="ownerEmail"
                type="email"
                label={t("territories.ownerEmail")}
                help={t("territories.ownerEmailHelp")}
                required
              />
              <Select
                id="exception-country"
                name="countryCode"
                label={t("territories.country")}
                placeholder={t("territories.countryChoose")}
                options={countries}
              />
              <Input
                id="exception-contract"
                name="contractReference"
                label={t("territories.contract")}
                help={t("territories.contractHelp")}
                required
                maxLength={200}
              />
              <Input
                id="exception-signed"
                name="contractSignedOn"
                type="date"
                label={t("territories.signedOn")}
                required
              />
              <ReasonField t={t} id="exception-reason" />
            </ActionForm>
          </Panel>
        ) : null}
      </Section>
      <Section id="territories-outside" title={t("territories.outside")}>
        <p className="m-0 text-text-13 text-text-secondary">{t("territories.outsideIntro")}</p>
        {!outside.ok ? (
          <Empty>{t("common.loadError")}</Empty>
        ) : outside.data.length === 0 ? (
          <Empty>{t("territories.outsideNone")}</Empty>
        ) : (
          <Table
            caption={t("territories.outside")}
            testId="territories-outside"
            columns={[
              t("territories.org"),
              t("territories.uses"),
              t("territories.country"),
              t("territories.exceptionContract"),
            ]}
            rows={outside.data.map((o) => ({
              key: o.id,
              cells: [
                <NextLink
                  key="org"
                  href={`/tenants/${o.id}` as Route}
                  className="text-accent-text underline"
                >
                  {o.name}
                </NextLink>,
                o.usesAtlas ? t("territories.usesAtlas") : t("territories.usesAccount"),
                o.countryCode ? name(o.countryCode) : t("territories.notRecorded"),
                o.exceptionContract ?? t("common.none"),
              ],
            }))}
          />
        )}
      </Section>
    </>
  );
}
