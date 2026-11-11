import {
  AGREEMENT_KINDS,
  AGREEMENT_STATES,
  getAgreement,
  listAgreements,
  type Agreement,
} from "@xos/data/people";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  createAgreementAction,
  transitionAgreementAction,
  updateAgreementAction,
} from "@/app/[org]/people/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { InlineAlert } from "@/components/crew/ui";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekTable } from "@/components/crew/views-peek-table";
import { SendAgreementButton, SignAgreementForm } from "@/components/people/send-agreement";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getProjects,
  withParams,
} from "@/lib/crew/context";
import { peopleStateIcon } from "@/lib/people/states";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { DocumentActions } from "@/components/documents/document-actions";
import { LiveList } from "@/components/live/live-list";

/**
 * People > Agreements (Section 4.5.5): offer letters, contractor agreements, MSAs and NDAs. Drafted
 * while Proposed, sent with a signing link and access code shown once (invariant 8), signed by the
 * named person in Gateway without an account or here while signed in. A signed agreement is never
 * revoked, unsigned or edited; it can only be superseded (journey 9).
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/people/agreements">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.agreements";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const stateFilter = AGREEMENT_STATES.find((s) => s === search["state"]);
  const result = await listAgreements(db, {
    orgId: crew.orgId,
    ...(stateFilter ? { states: [stateFilter] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list agreements: ${result.error.kind}`);
  const agreements = result.data;
  const canWrite = crew.can("people.agreement.write");
  const me = crew.ctx.viewer.person?.id ?? null;
  const party = (a: Agreement) => a.personName ?? t("crew.common.unnamed");

  let peek = null;
  let editing = null;
  const lookup = search["peek"] ?? search["edit"];
  if (lookup) {
    const detail = await getAgreement(db, lookup);
    if (detail.ok) {
      const a = detail.data;
      editing = a;
      if (search["peek"]) {
        const hidden = { org: crew.slug, id: a.id };
        const record = (
          <CrewRecord
            crew={crew}
            mode={search["full"] === "1" ? "full" : "peek"}
            kindLabel={t(`people.kinds.agreementKinds.${a.kind}`)}
            recordKey={a.state === "Signed" ? t("people.agreements.signedBadge") : ""}
            title={a.title}
            state={peopleStateIcon("agreement", a.state)}
            stateLabel={t(`people.states.agreement.${a.state}`)}
            stateName={(v) => t(`people.states.agreement.${v}`)}
            history={a.transitions}
            subject={{ table: "app.agreements", id: a.id }}
            backHref={withParams(base, search, { peek: null, full: null })}
            actions={
              canWrite ? (
                <>
                  {a.state === "Proposed" ? (
                    <>
                      <SendAgreementButton org={crew.slug} id={a.id} />
                      <ButtonLink
                        href={withParams(base, search, { peek: null, full: null, edit: a.id })}
                        size="sm"
                      >
                        {t("crew.common.edit")}
                      </ButtonLink>
                      <ConfirmButton
                        label={t("people.agreements.cancel")}
                        title={t("people.agreements.cancelTitle")}
                        defaultReason={t("people.agreements.cancelReason")}
                        action={transitionAgreementAction}
                        hidden={{ ...hidden, expected: "Proposed", next: "Canceled" }}
                        variant="ghost"
                      />
                    </>
                  ) : null}
                  {a.state === "Sent" ? (
                    <>
                      <ConfirmButton
                        label={t("people.agreements.recall")}
                        title={t("people.agreements.recallTitle")}
                        description={t("people.agreements.recallHelp")}
                        defaultReason={t("people.agreements.recallReason")}
                        action={transitionAgreementAction}
                        hidden={{ ...hidden, expected: "Sent", next: "Proposed" }}
                      />
                      <ConfirmButton
                        label={t("people.agreements.cancel")}
                        title={t("people.agreements.cancelTitle")}
                        defaultReason={t("people.agreements.cancelReason")}
                        action={transitionAgreementAction}
                        hidden={{ ...hidden, expected: "Sent", next: "Canceled" }}
                        variant="ghost"
                      />
                    </>
                  ) : null}
                  {a.state === "Signed" ? (
                    <ConfirmButton
                      label={t("people.agreements.supersede")}
                      title={t("people.agreements.supersedeTitle")}
                      description={t("people.agreements.supersedeHelp")}
                      defaultReason={t("people.agreements.supersedeReason")}
                      action={transitionAgreementAction}
                      hidden={{ ...hidden, expected: "Signed", next: "Superseded" }}
                    />
                  ) : null}
                </>
              ) : null
            }
            properties={[
              {
                label: t("people.agreements.kind"),
                value: t(`people.kinds.agreementKinds.${a.kind}`),
              },
              { label: t("people.agreements.party"), value: party(a) },
              {
                label: t("people.agreements.expires"),
                value: a.tokenExpiresAt
                  ? format.dateTime(new Date(a.tokenExpiresAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : t("people.agreements.notSent"),
              },
              {
                label: t("people.agreements.signed"),
                value: a.signedAt
                  ? t("people.agreements.signedBy", {
                      name: a.signedName ?? "",
                      at: format.dateTime(new Date(a.signedAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t("people.agreements.unsigned"),
              },
            ]}
          >
            {a.state === "Signed" || a.state === "Superseded" ? (
              <InlineAlert tone="info" title={t("people.agreements.permanentTitle")}>
                {t("people.agreements.permanentBody", { hash: a.signedBodySha256 ?? "" })}
              </InlineAlert>
            ) : null}
            {a.signedAt ? (
              <DocumentActions org={crew.slug} kind="agreement-certificate" id={a.id} />
            ) : null}
            {a.state === "Sent" && a.personId !== null && a.personId === me ? (
              <SignAgreementForm org={crew.slug} id={a.id} />
            ) : null}
            <section aria-labelledby="agreement-text" className="flex flex-col gap-4">
              <h2 id="agreement-text" className="m-0 text-text-13 font-semibold">
                {t("people.agreements.text")}
              </h2>
              <div className="max-h-(--layout-peek) overflow-y-auto whitespace-pre-wrap rounded-card border border-border-subtle p-12 text-text-13">
                {a.body}
              </div>
            </section>
          </CrewRecord>
        );
        if (search["full"] === "1") return record;
        peek = record;
      }
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read agreement: ${detail.error.kind}`);
    }
  }

  let drawer = null;
  if (search["create"] === "1" && canWrite) {
    const [members, projects] = await Promise.all([getMembers(crew.ctx), getProjects(crew.ctx)]);
    drawer = (
      <DrawerForm
        title={t("people.agreements.createTitle")}
        submitLabel={t("people.agreements.create")}
        action={createAgreementAction}
        openKeys={["create", "offer"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          ...(search["offer"]
            ? [{ kind: "hidden" as const, name: "offerId", value: search["offer"] }]
            : []),
          {
            kind: "select",
            name: "kind",
            label: t("people.agreements.kind"),
            value: search["offer"] ? "Offer Letter" : "Contractor Agreement",
            options: AGREEMENT_KINDS.map((k) => ({
              value: k,
              label: t(`people.kinds.agreementKinds.${k}`),
            })),
          },
          {
            kind: "select",
            name: "personId",
            label: t("people.agreements.signer"),
            options: members.flatMap((m) =>
              m.personId ? [{ value: m.personId, label: m.name ?? t("crew.common.unnamed") }] : [],
            ),
            help: t("people.agreements.signerHelp"),
          },
          {
            kind: "select",
            name: "projectId",
            label: t("crew.fields.project"),
            value: "",
            options: [
              { value: "", label: t("people.agreements.orgWide") },
              ...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
            ],
          },
          { kind: "text", name: "title", label: t("people.agreements.titleLabel"), required: true },
          {
            kind: "textarea",
            name: "body",
            label: t("people.agreements.text"),
            required: true,
            help: t("people.agreements.textHelp"),
          },
        ]}
      />
    );
  } else if (editing && search["edit"] && canWrite && editing.state === "Proposed") {
    drawer = (
      <DrawerForm
        title={t("people.agreements.editTitle")}
        submitLabel={t("crew.common.save")}
        action={updateAgreementAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: editing.id },
          {
            kind: "text",
            name: "title",
            label: t("people.agreements.titleLabel"),
            value: editing.title,
            required: true,
          },
          {
            kind: "textarea",
            name: "body",
            label: t("people.agreements.text"),
            value: editing.body,
            required: true,
          },
        ]}
      />
    );
  }

  let body;
  if (agreements.length === 0) {
    body = (
      <EmptyStateLink
        icon="FileSignature"
        sentence={
          stateFilter
            ? t("crew.swapsPage.emptyFiltered")
            : canWrite
              ? t("people.agreements.emptyWriter")
              : t("people.agreements.emptyReader")
        }
        actionLabel={
          stateFilter
            ? t("crew.common.clearFilter")
            : canWrite
              ? t("people.agreements.create")
              : t("people.agreements.viewOffers")
        }
        href={
          stateFilter
            ? withParams(base, search, { state: null })
            : canWrite
              ? withParams(base, search, { create: "1" })
              : `/${crew.slug}/people/offers`
        }
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("people.agreements.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {agreements.map((a) => (
          <li key={a.id}>
            <Link
              href={withParams(base, search, { peek: a.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{a.title}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", {
                    a: t(`people.kinds.agreementKinds.${a.kind}`),
                    b: party(a),
                  })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`people.states.agreement.${a.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("people.agreements.caption")}
        columns={[
          { key: "title", label: t("people.agreements.titleLabel"), wrap: true },
          { key: "kind", label: t("people.agreements.kind") },
          { key: "party", label: t("people.agreements.party") },
          { key: "created", label: t("people.agreements.created") },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={agreements.map((a) => ({
          id: a.id,
          title: a.title,
          kind: t(`people.kinds.agreementKinds.${a.kind}`),
          party: party(a),
          created: format.dateTime(new Date(a.createdAt), { dateStyle: "medium" }),
          state: {
            state: peopleStateIcon("agreement", a.state),
            label: t(`people.states.agreement.${a.state}`),
          },
        }))}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="people"
      params={routeParams}
      search={search}
      count={agreements.length}
      view={view}
      {...(canWrite
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("people.agreements.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <FilterSelect
          name="state"
          label={t("crew.fields.state")}
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("crew.common.allStates") },
            ...AGREEMENT_STATES.map((v) => ({
              value: v,
              label: t(`people.states.agreement.${v}`),
            })),
          ]}
        />
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      <LiveList org={routeParams.org} tables={["agreements"]} />
      {body}
    </CrewFrame>
  );
}
