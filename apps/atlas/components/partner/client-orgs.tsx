"use client";

import { slugFromName } from "@xos/data/slug";
import { Button, DataTable, Drawer, Input, PropertyList, Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  createClientOrgAction,
  endSupportSessionAction,
  setClientPriceAction,
} from "@/app/partner/[partnerSlug]/actions";
import { ActionForm, EmptyPanel, usePlatformT } from "@/components/platform/kit";
import type { PlatformActionState } from "@/lib/platform/state";

export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
  readonly seats: number;
  readonly owner: string;
  readonly session: string;
  readonly price: string;
}

export interface ClientDetail {
  readonly id: string;
  readonly name: string;
  readonly plan: string;
  readonly seats: number;
  readonly fieldMembers: number;
  readonly ownerJoined: boolean;
  readonly sessionId: string | null;
  readonly sessionEndsAt: string | null;
  readonly accent: string | null;
  readonly inherited: boolean;
  /** The client's venues as row level security lets the viewer read them; null when the read failed. */
  readonly venues: readonly { id: string; name: string; locality: string | null }[] | null;
  readonly priceAmount: string;
  readonly priceCurrency: string;
}

const PLAN_CODES = ["access", "core", "pro", "team", "enterprise"] as const;
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;

export function ClientOrgsView({
  org,
  rows,
  creating,
  detail,
}: {
  org: string;
  rows: readonly ClientRow[];
  creating: boolean;
  detail: ClientDetail | null;
}) {
  const t = usePlatformT();
  const router = useRouter();
  const pathname = usePathname();
  const go = (query: string) => router.push(`${pathname}${query}` as Route, { scroll: false });

  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <p className="m-0 max-w-layout-form text-text-13 text-text-secondary">
          {t("partner.clients.intro")}
        </p>
        <Button variant="primary" onClick={() => go("?create=1")}>
          {t("partner.clients.create")}
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyPanel
          icon="Building2"
          sentence={t("partner.clients.empty")}
          actionLabel={t("partner.clients.create")}
          href={`${pathname}?create=1`}
        />
      ) : (
        <DataTable
          caption={t("partner.clients.caption")}
          label={t("partner.clients.caption")}
          height="auto"
          columns={[
            { key: "name", label: t("partner.clients.columns.name") },
            { key: "plan", label: t("partner.clients.columns.plan") },
            { key: "seats", label: t("partner.clients.columns.seats"), type: "number" },
            { key: "owner", label: t("partner.clients.columns.owner") },
            { key: "session", label: t("partner.clients.columns.session") },
            { key: "price", label: t("partner.clients.columns.price") },
          ]}
          rows={rows.map((r) => ({ ...r }))}
          onRowActivate={(row) => go(`?client=${String(row["id"])}`)}
        />
      )}
      {creating ? <CreateClientDrawer org={org} onClose={() => go("")} /> : null}
      {detail ? <ClientDrawer org={org} detail={detail} onClose={() => go("")} /> : null}
    </div>
  );
}

function CreateClientDrawer({ org, onClose }: { org: string; onClose: () => void }) {
  const t = usePlatformT();
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [plan, setPlan] = useState<string>("core");
  const [invite, setInvite] = useState<string | null>(null);
  return (
    <Drawer
      title={t("partner.clients.createTitle")}
      open
      onOpenChange={(open) => (open ? null : onClose())}
    >
      {invite ? (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13">{t("partner.clients.inviteReady")}</p>
          <Input
            id="client-invite-link"
            label={t("partner.clients.inviteLink")}
            value={invite}
            readOnly
            width="100%"
          />
          <p className="m-0 text-text-12 text-text-secondary">{t("partner.clients.inviteOnce")}</p>
          <div className="flex gap-8">
            <Button variant="primary" onClick={() => void navigator.clipboard.writeText(invite)}>
              {t("partner.clients.copyInvite")}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t("common.done")}
            </Button>
          </div>
        </div>
      ) : (
        <ActionForm
          action={createClientOrgAction}
          hidden={{ org, slug, plan }}
          label={t("partner.clients.createTitle")}
          submitLabel={t("partner.clients.createSubmit")}
          onDone={(state: PlatformActionState) => setInvite(state.value ?? null)}
        >
          <Input
            id="client-name"
            name="name"
            label={t("partner.clients.fields.name")}
            required
            maxLength={200}
            width="100%"
            onChange={(e) => {
              if (!touched) setSlug(slugFromName(e.target.value));
            }}
          />
          <Input
            id="client-slug"
            label={t("partner.clients.fields.slug")}
            help={t("partner.clients.fields.slugHelp")}
            value={slug}
            required
            maxLength={48}
            width="100%"
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
          <Input
            id="client-owner"
            name="ownerEmail"
            type="email"
            label={t("partner.clients.fields.owner")}
            help={t("partner.clients.fields.ownerHelp")}
            required
            width="100%"
          />
          <Select
            label={t("partner.clients.fields.plan")}
            value={plan}
            options={PLAN_CODES.map((p) => ({ value: p, label: t(`partner.plans.${p}`) }))}
            onChange={(e) => setPlan(e.target.value)}
          />
        </ActionForm>
      )}
    </Drawer>
  );
}

function ClientDrawer({
  org,
  detail,
  onClose,
}: {
  org: string;
  detail: ClientDetail;
  onClose: () => void;
}) {
  const t = usePlatformT();
  const router = useRouter();
  const [currency, setCurrency] = useState(detail.priceCurrency);
  return (
    <Drawer title={detail.name} open onOpenChange={(open) => (open ? null : onClose())}>
      <PropertyList
        items={[
          { label: t("partner.clients.columns.plan"), value: detail.plan },
          { label: t("partner.clients.columns.seats"), value: String(detail.seats) },
          { label: t("partner.clients.fieldMembers"), value: String(detail.fieldMembers) },
          {
            label: t("partner.clients.columns.owner"),
            value: detail.ownerJoined
              ? t("partner.clients.ownerJoined")
              : t("partner.clients.ownerInvited"),
          },
          {
            label: t("partner.clients.brand"),
            value: (
              <span className="inline-flex items-center gap-8">
                {detail.accent ? (
                  <span
                    aria-hidden="true"
                    className="inline-block size-16 rounded-control border border-border-subtle"
                    // design-audit-allow: the client's brand accent is data, not a design value
                    style={{ backgroundColor: detail.accent }}
                  />
                ) : null}
                {detail.accent
                  ? detail.inherited
                    ? t("partner.clients.brandInherited", { accent: detail.accent })
                    : t("partner.clients.brandOwn", { accent: detail.accent })
                  : t("partner.clients.brandPlatform")}
              </span>
            ),
          },
        ]}
      />

      <section aria-labelledby="client-data" className="flex flex-col gap-8">
        <h3 id="client-data" className="m-0 text-text-14 font-semibold">
          {t("partner.clients.dataTitle")}
        </h3>
        {detail.sessionId === null ? (
          <p
            role="note"
            className="m-0 rounded-card border border-border-subtle p-12 text-text-13 text-text-secondary"
          >
            {t("partner.clients.noSessionBody")}
          </p>
        ) : (
          <>
            <p className="m-0 text-text-13">
              {t("partner.clients.sessionOpen", { when: detail.sessionEndsAt ?? "" })}
            </p>
            {detail.venues === null ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("partner.clients.dataError")}
              </p>
            ) : detail.venues.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("partner.clients.noVenues")}
              </p>
            ) : (
              <ul
                aria-label={t("partner.clients.venues")}
                className="m-0 flex list-none flex-col gap-4 p-0"
              >
                {detail.venues.map((v) => (
                  <li key={v.id} className="text-text-13">
                    {v.name}
                    {v.locality ? (
                      <span className="text-text-secondary"> · {v.locality}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <ActionForm
              action={endSupportSessionAction}
              hidden={{ org, session: detail.sessionId }}
              label={t("partner.clients.endSession")}
              submitLabel={t("partner.clients.endSession")}
              submitVariant="secondary"
              onDone={() => router.refresh()}
            />
          </>
        )}
      </section>

      <section aria-labelledby="client-price" className="flex flex-col gap-8">
        <h3 id="client-price" className="m-0 text-text-14 font-semibold">
          {t("partner.clients.priceTitle")}
        </h3>
        <p className="m-0 text-text-12 text-text-secondary">{t("partner.clients.priceHelp")}</p>
        <ActionForm
          action={setClientPriceAction}
          hidden={{ org, client: detail.id, currency }}
          label={t("partner.clients.priceTitle")}
          submitLabel={t("partner.clients.priceSave")}
          success={t("partner.clients.priceSaved")}
          inline
        >
          <Input
            id="client-price-amount"
            name="amount"
            inputMode="decimal"
            label={t("partner.clients.priceAmount")}
            defaultValue={detail.priceAmount}
            required
            pattern="\d+(\.\d{1,2})?"
            width={160}
          />
          <Select
            label={t("partner.clients.priceCurrency")}
            value={currency}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            onChange={(e) => setCurrency(e.target.value)}
          />
        </ActionForm>
      </section>
    </Drawer>
  );
}
