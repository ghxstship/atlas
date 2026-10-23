import { searchOrgs } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { Empty, PageHeader, Table } from "@/components/page";
import { Button, Input, Select } from "@/components/ui";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

const PLANS = ["access", "core", "pro", "team", "enterprise"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("tenants.title") };
}

/** Tenant search (A90, Section 4.10): orgs by name, slug, Owner email and plan in force. */
export default async function TenantsPage({ searchParams }: PageProps<"/tenants">) {
  const ctx = await requirePermission("tenants.read");
  const query = await searchParams;
  const q = typeof query["q"] === "string" ? query["q"].slice(0, 200) : "";
  const plan =
    typeof query["plan"] === "string" && (PLANS as readonly string[]).includes(query["plan"])
      ? query["plan"]
      : "";
  const { t, label, instant, number } = await getConsoleFormat();
  const result = await searchOrgs(ctx.db, { query: q, planCode: plan || null });
  return (
    <>
      <PageHeader title={t("tenants.title")} intro={t("tenants.intro")} />
      <form
        method="get"
        role="search"
        className="flex flex-wrap items-end gap-12"
        aria-label={t("tenants.search")}
      >
        <Input
          id="tenant-query"
          name="q"
          type="search"
          label={t("tenants.searchLabel")}
          defaultValue={q}
          width={320}
        />
        <Select
          id="tenant-plan"
          name="plan"
          label={t("tenants.plan")}
          value={plan}
          options={[
            { value: "", label: t("tenants.anyPlan") },
            ...PLANS.map((p) => ({ value: p, label: t(`plans.${p}`) })),
          ]}
        />
        <Button type="submit">{t("tenants.search")}</Button>
      </form>
      {!result.ok ? (
        <Empty>{t("common.loadError")}</Empty>
      ) : result.data.length === 0 ? (
        <Empty>{t("tenants.none")}</Empty>
      ) : (
        <Table
          caption={t("tenants.results")}
          testId="tenant-results"
          columns={[
            t("tenants.columns.org"),
            t("tenants.columns.plan"),
            t("tenants.columns.state"),
            t("tenants.columns.owner"),
            t("tenants.columns.seats"),
            t("tenants.columns.status"),
            t("tenants.columns.created"),
          ]}
          rows={result.data.map((org) => ({
            key: org.orgId,
            cells: [
              <span key="org" className="flex flex-col gap-4">
                <NextLink
                  href={`/tenants/${org.orgId}` as Route}
                  className="font-medium text-accent-text underline"
                >
                  {org.name}
                </NextLink>
                <span className="text-text-12 text-text-secondary">{org.slug}</span>
                {org.parentOrgName ? (
                  <span className="text-text-12 text-text-secondary">
                    {t("tenants.clientOf", { partner: org.parentOrgName })}
                  </span>
                ) : null}
              </span>,
              label("plans", org.planCode),
              org.subscriptionState
                ? label("subscription", org.subscriptionState)
                : t("subscription.none"),
              <span key="owner" className="flex flex-col gap-4">
                <span>
                  {org.ownerName ?? (org.ownerEmail ? t("common.unknownPerson") : t("common.none"))}
                </span>
                {org.ownerEmail ? (
                  <span className="text-text-12 text-text-secondary">{org.ownerEmail}</span>
                ) : null}
              </span>,
              number(org.seats),
              org.canceled ? t("tenants.canceled") : t("tenants.active"),
              instant(org.createdAt),
            ],
          }))}
        />
      )}
    </>
  );
}
