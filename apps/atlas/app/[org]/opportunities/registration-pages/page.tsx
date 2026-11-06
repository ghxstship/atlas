import { listPools } from "@xos/data/opportunities";
import { listQuestionTemplates } from "@xos/data/opportunity-templates";
import {
  listRegistrationPages,
  listRegistrationQuestions,
  listRegistrations,
  type RegistrationPage,
} from "@xos/data/registration";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/opportunities/action-form";
import { CopyText } from "@/components/opportunities/copy-text";
import { Muted, RowLink, Section, Table, ViewSwitch } from "@/components/opportunities/parts";
import { RegistrationQueue } from "@/components/opportunities/registration-queue";
import {
  Card,
  InlineAlert,
  PageHeader,
  Tag,
  TemplateCollection,
} from "@/components/opportunities/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { gatewayUrl } from "@/lib/gateway-url";
import { must, setupPage, type PageSetup, type SearchParams } from "@/lib/opportunities/page";
import {
  addRegistrationQuestionAction,
  applyRegistrationTemplateAction,
  inviteToRegistrationAction,
  removeRegistrationQuestionAction,
  saveRegistrationPageAction,
  transitionRegistrationPageAction,
  updateRegistrationQuestionAction,
} from "./actions";

/**
 * Registration pages (B10, G-129, ADR 0149 decision 3): an org's public page that fills a Talent pool. Crew and volunteers
 * register from Gateway with their own account, the page never names the pool, and an approval makes them a member.
 * Every plan has them. `?page=<id>` opens one page with its questions; the queue sits below the list.
 */
export default async function RegistrationPagesPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/registration-pages">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.registration-pages",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t, param } = page;
  const db = ctx.viewer.db;
  const canWrite = ctx.capabilities.has("opportunities.pool.write");
  const [pages, pools] = await Promise.all([
    listRegistrationPages(db, ctx.org.id),
    canWrite ? listPools(db, ctx.org.id) : Promise.resolve(null),
  ]);
  const rows = must(pages, "registration pages");
  const talent = pools ? must(pools, "pools").filter((p) => p.kind === "Talent") : [];
  const openId = param("page");
  if (openId) {
    const open = rows.find((r) => r.id === openId);
    if (!open) notFound();
    return <PageRecord page={page} record={open} canWrite={canWrite} pools={talent} />;
  }
  const creating = param("create") === "1" && canWrite;
  const registrations = must(await listRegistrations(db, { orgId: ctx.org.id }), "registrations");
  const publicLink = (r: RegistrationPage) => gatewayUrl(`/join/${ctx.org.slug}/${r.slug}`);
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("registrationPages.title")}
          count={rows.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v })}
            />
          }
          actions={
            canWrite && !creating ? (
              <ButtonLink href={page.href({ create: "1" })} variant="primary">
                {t("registrationPages.new")}
              </ButtonLink>
            ) : null
          }
        />
      }
    >
      {creating ? (
        talent.length === 0 ? (
          <InlineAlert tone="info">{t("registrationPages.noPools")}</InlineAlert>
        ) : (
          <Card title={t("registrationPages.createTitle")}>
            <ActionForm
              action={saveRegistrationPageAction}
              hidden={{ org: ctx.org.slug, id: "" }}
              fields={pageFields(page, talent)}
              submitLabel={t("registrationPages.create")}
              successLabel={t("registrationPages.created")}
            />
          </Card>
        )
      ) : null}
      {rows.length === 0 && !creating ? (
        <EmptyStateLink
          icon="ClipboardList"
          sentence={t("registrationPages.empty")}
          actionLabel={canWrite ? t("registrationPages.new") : t("registrationPages.emptyRead")}
          href={page.href({ create: "1" })}
          secondary
        />
      ) : page.view === "table" ? (
        <Table
          caption={t("registrationPages.title")}
          rowKey={(r) => r.id}
          rows={rows}
          columns={[
            {
              key: "title",
              label: t("registrationPages.fields.title"),
              cell: (r: RegistrationPage) => (
                <RowLink href={page.href({ page: r.id })}>{r.title}</RowLink>
              ),
            },
            {
              key: "state",
              label: t("registrationPages.fields.state"),
              cell: (r: RegistrationPage) => (
                <Tag tone="neutral">{t(`registrationPages.states.${r.state}`)}</Tag>
              ),
            },
            {
              key: "open",
              label: t("registrationPages.fields.openRegistrations"),
              numeric: true,
              cell: (r: RegistrationPage) => r.openRegistrations,
            },
            {
              key: "link",
              label: t("registrationPages.fields.publicLink"),
              cell: (r: RegistrationPage) => (
                <CopyText text={publicLink(r)} label={t("registrationPages.copyLink")} />
              ),
            },
          ]}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <RowLink href={page.href({ page: r.id })}>{r.title}</RowLink>
              <span className="flex flex-wrap items-center gap-8 text-text-12 text-text-secondary">
                <Tag tone="neutral">{t(`registrationPages.states.${r.state}`)}</Tag>
                {t("registrationPages.openCount", { count: r.openRegistrations })}
                <CopyText text={publicLink(r)} label={t("registrationPages.copyLink")} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {registrations.length > 0 ? (
        <Section id="registrations" title={t("registrations.title")}>
          <RegistrationQueue org={ctx.org.slug} rows={registrations} />
        </Section>
      ) : null}
    </TemplateCollection>
  );
}

function pageFields(
  page: PageSetup,
  pools: readonly { id: string; name: string }[],
  record?: RegistrationPage,
) {
  const { t } = page;
  return [
    {
      name: "title",
      label: t("registrationPages.fields.title"),
      kind: "text" as const,
      required: true,
      defaultValue: record?.title ?? "",
    },
    {
      name: "slug",
      label: t("registrationPages.fields.slug"),
      kind: "text" as const,
      required: true,
      defaultValue: record?.slug ?? "",
      help: t("registrationPages.slugHelp"),
    },
    {
      name: "intro",
      label: t("registrationPages.fields.intro"),
      kind: "textarea" as const,
      defaultValue: record?.intro ?? "",
    },
    {
      name: "poolId",
      label: t("registrationPages.fields.pool"),
      kind: "select" as const,
      defaultValue: record?.poolId ?? pools[0]?.id ?? "",
      options: pools.map((p) => ({ value: p.id, label: p.name })),
      help: t("registrationPages.poolHelp"),
    },
    {
      name: "minimumAge",
      label: t("registrationPages.fields.minimumAge"),
      kind: "number" as const,
      required: true,
      min: 16,
      max: 99,
      defaultValue: String(record?.minimumAge ?? 16),
      help: t("registrationPages.minimumAgeHelp"),
    },
  ];
}

async function PageRecord({
  page,
  record,
  canWrite,
  pools,
}: {
  page: PageSetup;
  record: RegistrationPage;
  canWrite: boolean;
  pools: readonly { id: string; name: string }[];
}) {
  const { ctx, t } = page;
  const db = ctx.viewer.db;
  const draft = record.state === "Draft";
  const [questions, templates, registrations] = await Promise.all([
    listRegistrationQuestions(db, record.id),
    canWrite && draft ? listQuestionTemplates(db, ctx.org.id) : Promise.resolve(null),
    listRegistrations(db, { orgId: ctx.org.id, pageId: record.id }),
  ]);
  const asked = must(questions, "registration questions");
  const templateRows = templates ? must(templates, "question templates") : [];
  const hidden = { org: ctx.org.slug };
  const queue = must(registrations, "registrations");
  return (
    <div className="flex flex-col gap-16">
      <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
        <Link
          href={page.href({ page: null }) as Route}
          className="text-text-12 text-text-secondary hover:text-text-primary"
        >
          {t("registrationPages.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-8">
          <h1 className="m-0 text-heading-20 font-semibold">{record.title}</h1>
          <Tag tone="neutral">{t(`registrationPages.states.${record.state}`)}</Tag>
        </div>
        <CopyText
          text={gatewayUrl(`/join/${ctx.org.slug}/${record.slug}`)}
          label={t("registrationPages.copyLink")}
        />
      </header>
      {canWrite ? (
        <Section id="registration-page" title={t("registrationPages.editTitle")}>
          <ActionForm
            action={saveRegistrationPageAction}
            hidden={{ ...hidden, id: record.id }}
            fields={pageFields(page, pools, record)}
            submitLabel={t("registrationPages.save")}
            successLabel={t("registrationPages.saved")}
          />
          <div className="flex flex-wrap gap-8">
            {draft || record.state === "Closed" ? (
              <ActionForm
                action={transitionRegistrationPageAction}
                hidden={{ ...hidden, id: record.id, expected: record.state, next: "Open" }}
                fields={[]}
                inline
                variant="primary"
                submitLabel={t("registrationPages.publish")}
              />
            ) : null}
            {record.state !== "Closed" ? (
              <ActionForm
                action={transitionRegistrationPageAction}
                hidden={{ ...hidden, id: record.id, expected: record.state, next: "Closed" }}
                fields={[]}
                inline
                submitLabel={t("registrationPages.close")}
              />
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section id="registration-questions" title={t("registrationPages.questions")}>
        <InlineAlert tone="info">{t("registrationPages.questionHint")}</InlineAlert>
        {asked.length === 0 ? <Muted>{t("registrationPages.noQuestions")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {asked.map((q) => (
            <li
              key={q.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-8"
            >
              {canWrite && draft ? (
                <div className="flex flex-wrap items-end gap-8">
                  <ActionForm
                    action={updateRegistrationQuestionAction}
                    hidden={{ ...hidden, id: q.id }}
                    inline
                    fields={[
                      {
                        name: "prompt",
                        label: t("registrationPages.prompt"),
                        kind: "text",
                        required: true,
                        defaultValue: q.prompt,
                      },
                      {
                        name: "isRequired",
                        label: t("registrationPages.required"),
                        kind: "checkbox",
                        defaultValue: q.isRequired ? "true" : "",
                      },
                    ]}
                    submitLabel={t("registrationPages.saveQuestion")}
                  />
                  <ActionForm
                    action={removeRegistrationQuestionAction}
                    hidden={{ ...hidden, id: q.id }}
                    inline
                    fields={[]}
                    variant="danger"
                    submitLabel={t("remove")}
                  />
                </div>
              ) : (
                <p className="m-0 text-text-13">
                  {q.prompt}{" "}
                  {q.isRequired ? (
                    <Tag tone="neutral">{t("registrationPages.required")}</Tag>
                  ) : null}
                </p>
              )}
            </li>
          ))}
        </ul>
        {canWrite && draft ? (
          <div className="flex flex-col gap-12">
            <ActionForm
              action={addRegistrationQuestionAction}
              hidden={{ ...hidden, pageId: record.id }}
              title={t("registrationPages.addQuestion")}
              fields={[
                {
                  name: "prompt",
                  label: t("registrationPages.prompt"),
                  kind: "text",
                  required: true,
                  help: t("registrationPages.promptHelp"),
                },
                { name: "isRequired", label: t("registrationPages.required"), kind: "checkbox" },
              ]}
              submitLabel={t("registrationPages.addQuestionSubmit")}
            />
            {templateRows.length > 0 ? (
              <ActionForm
                action={applyRegistrationTemplateAction}
                hidden={{ ...hidden, pageId: record.id }}
                title={t("registrationPages.applyTemplate")}
                fields={[
                  {
                    name: "templateId",
                    label: t("registrationPages.template"),
                    kind: "select",
                    defaultValue: templateRows[0]?.id ?? "",
                    options: templateRows.map((x) => ({ value: x.id, label: x.name })),
                  },
                ]}
                submitLabel={t("registrationPages.applyTemplateSubmit")}
              />
            ) : null}
          </div>
        ) : null}
      </Section>
      {canWrite && record.state === "Open" ? (
        <Section id="registration-invite" title={t("registrationPages.inviteTitle")}>
          <ActionForm
            action={inviteToRegistrationAction}
            hidden={{ ...hidden, pageId: record.id }}
            fields={[
              {
                name: "includePastCrew",
                label: t("registrationPages.includePastCrew"),
                kind: "checkbox",
                help: t("registrationPages.includePastCrewHelp"),
              },
            ]}
            submitLabel={t("registrationPages.invite")}
            successLabel={t("registrationPages.invited")}
          />
        </Section>
      ) : null}
      <Section id="page-registrations" title={t("registrations.title")}>
        {queue.length === 0 ? (
          <Muted>{t("registrations.empty")}</Muted>
        ) : (
          <RegistrationQueue org={ctx.org.slug} rows={queue} />
        )}
      </Section>
    </div>
  );
}
