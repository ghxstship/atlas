import {
  getFormTemplate,
  listFormSubmissions,
  listFormTemplates,
  listRecordKindOptions,
  type FormSubmission,
  type FormTemplate,
} from "@xos/data/workforce-forms";
import { listRoles } from "@xos/data";
import { listProjects } from "@xos/data/projects";
import { getFormatter } from "next-intl/server";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  createFormAction,
  decideSubmissionAction,
  publishFormAction,
  retireFormAction,
  updateFormAction,
} from "@/lib/workforce/actions";
import { fieldListText } from "@/lib/workforce/parse";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { QuerySwitch } from "./client";
import { FormFiller } from "./form-filler";
import { REFUSALS, workforceCopy } from "./shared";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list"];

function templateState(f: FormTemplate, t: Copy): KitState {
  return f.state === "Draft"
    ? { state: "proposed", label: t("forms.states.Draft") }
    : f.state === "Published"
      ? { state: "active", label: t("forms.states.Published") }
      : { state: "canceled", label: t("forms.states.Retired") };
}

function submissionState(s: FormSubmission, t: Copy): KitState {
  const map: Record<string, KitState["state"]> = {
    Submitted: "in-review",
    Approved: "complete",
    Rejected: "canceled",
    Recorded: "complete",
  };
  return { state: map[s.state] ?? "proposed", label: t(`forms.submissionStates.${s.state}`) };
}

/**
 * Knowledge > Forms (Section 4.9 Forms): the no-code form builder and every submission. A form has
 * conditional fields, required photos, a GPS stamp, a signature, scoring and an approver role; each
 * submission on a project becomes a record of the form's canon kind. The database validates every
 * answer, so a refused submission says which field to fix.
 */
export async function FormsSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const section = search["section"] === "submissions" ? "submissions" : "forms";
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, templates, submissions] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listFormTemplates(db, ctx.org.id),
    listFormSubmissions(db, ctx.org.id),
  ]);
  const title = t("forms.title");
  if (!templates.ok || !submissions.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("forms.what")} />
      </CollectionPage>
    );
  }
  const canWrite = ctx.capabilities.has("knowledge.sop.write");
  const canPublish = ctx.capabilities.has("knowledge.sop.publish");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const tabs = (
    <QuerySwitch
      label={t("forms.sections")}
      name="section"
      value={section}
      options={[
        { value: "forms", label: t("forms.forms") },
        { value: "submissions", label: t("forms.submissions") },
      ]}
    />
  );

  if (section === "submissions") {
    const selected = state.peek ? submissions.data.find((s) => s.id === state.peek) : undefined;
    const drawer = selected ? (
      <PeekDrawer
        recordKey={selected.templateName ?? t("forms.form")}
        title={selected.submittedByName ?? t("someone")}
        state={submissionState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("forms.submittedAt"), value: when(selected.createdAt) },
          {
            label: t("forms.version"),
            value: selected.version === null ? t("forms.none") : String(selected.version),
          },
          {
            label: t("forms.score"),
            value:
              selected.score === null
                ? t("forms.notScored")
                : `${selected.score} / ${selected.maxScore ?? 0}`,
          },
          {
            label: t("forms.passed"),
            value:
              selected.passed === null ? t("forms.none") : selected.passed ? t("yes") : t("no"),
          },
          {
            label: t("forms.location"),
            value:
              selected.latitude === null
                ? t("forms.none")
                : `${selected.latitude}, ${selected.longitude}`,
          },
          { label: t("forms.signedBy"), value: selected.signerName ?? t("forms.none") },
        ]}
        actions={
          selected.state === "Submitted" &&
          selected.submittedByMembershipId !== ctx.org.membershipId ? (
            <>
              <ActionButton
                action={decideSubmissionAction}
                hidden={{ org: ctx.org.slug, id: selected.id, approve: "true" }}
                label={t("forms.approve")}
                variant="primary"
                refusals={REFUSALS}
              />
              <ActionButton
                action={decideSubmissionAction}
                hidden={{ org: ctx.org.slug, id: selected.id, approve: "false" }}
                label={t("forms.reject")}
                variant="danger"
                reason={t("forms.rejectReason")}
                refusals={REFUSALS}
              />
            </>
          ) : null
        }
      >
        <dl className="m-0 grid gap-8 text-text-13">
          {Object.entries(selected.answers).map(([key, value]) => (
            <div key={key}>
              <dt className="font-medium">{key}</dt>
              <dd className="m-0 text-text-secondary">
                {Array.isArray(value) ? value.join(", ") : String(value)}
              </dd>
            </div>
          ))}
        </dl>
        {selected.decisionNote ? (
          <p className="m-0 text-text-13">{t("forms.note", { note: selected.decisionNote })}</p>
        ) : null}
        <CollabPanels ctx={ctx} table="app.form_submissions" id={selected.id} />
      </PeekDrawer>
    ) : null;
    const rows: KitRow[] = submissions.data.map((s) => ({
      id: s.id,
      key: s.templateName ?? t("forms.form"),
      title: s.submittedByName ?? t("someone"),
      state: submissionState(s, t),
      meta: when(s.createdAt),
      cells: {
        form: s.templateName ?? t("forms.form"),
        by: s.submittedByName ?? t("someone"),
        state: submissionState(s, t),
        score: s.score,
        at: when(s.createdAt),
      },
    }));
    return (
      <CollectionView
        title={t("forms.submissions")}
        views={VIEWS}
        view={state.view}
        columns={[
          { key: "form", label: t("forms.form") },
          { key: "by", label: t("forms.submittedBy") },
          { key: "state", label: t("feed.state"), type: "state" },
          { key: "score", label: t("forms.score"), type: "number" },
          { key: "at", label: t("forms.submittedAt") },
        ]}
        rows={rows}
        actions={tabs}
        empty={<EmptyRefresh icon="ClipboardCheck" sentence={t("forms.noSubmissions")} />}
      >
        {drawer}
      </CollectionView>
    );
  }

  const visible = templates.data;
  const selected = state.peek ? visible.find((f) => f.id === state.peek) : undefined;
  const [kinds, roles, projects] = await Promise.all([
    listRecordKindOptions(db),
    listRoles(db, ctx.org.id),
    listProjects(db, ctx.org.id),
  ]);
  const kindOptions = (kinds.ok ? kinds.data : []).flatMap((k) =>
    k.subtypes.length === 0
      ? [{ value: k.kind, label: k.kind }]
      : k.subtypes.map((s) => ({ value: `${k.kind}/${s}`, label: `${k.kind} · ${s}` })),
  );
  const roleOptions = (roles.ok ? roles.data : []).map((r) => ({
    value: r.id,
    label: r.name ?? r.code,
  }));
  const templateFields = (f?: FormTemplate) => [
    {
      kind: "text" as const,
      name: "name",
      label: t("forms.name"),
      required: true,
      defaultValue: f?.name ?? "",
    },
    {
      kind: "textarea" as const,
      name: "description",
      label: t("forms.description"),
      rows: 2,
      defaultValue: f?.description ?? "",
    },
    {
      kind: "select" as const,
      name: "recordKind",
      label: t("forms.recordKind"),
      required: true,
      help: t("forms.recordKindHelp"),
      defaultValue: f
        ? f.recordSubtype
          ? `${f.recordKind}/${f.recordSubtype}`
          : f.recordKind
        : "",
      options: kindOptions,
      blankLabel: t("feed.pickOne"),
    },
    {
      kind: "textarea" as const,
      name: "fields",
      label: t("forms.fields"),
      required: true,
      rows: 10,
      help: t("forms.fieldsHelp"),
      defaultValue: f ? fieldListText(f.fields) : "",
    },
    {
      kind: "checkboxes" as const,
      name: "rules",
      label: t("forms.rules"),
      options: [
        { value: "requiresSignature", label: t("forms.requiresSignature") },
        { value: "requiresLocation", label: t("forms.requiresLocation") },
      ],
      defaultValues: [
        ...(f?.requiresSignature ? ["requiresSignature"] : []),
        ...(f?.requiresLocation ? ["requiresLocation"] : []),
      ],
    },
    {
      kind: "number" as const,
      name: "passScore",
      label: t("forms.passScore"),
      help: t("forms.passScoreHelp"),
      defaultValue: f?.passScore === null || f?.passScore === undefined ? "" : String(f.passScore),
    },
    {
      kind: "select" as const,
      name: "approverRoleId",
      label: t("forms.approverRole"),
      help: t("forms.approverRoleHelp"),
      blankLabel: t("forms.noApproval"),
      defaultValue: f?.approverRoleId ?? "",
      options: roleOptions,
    },
  ];

  if (selected && state.full) {
    const fresh = await getFormTemplate(db, selected.id);
    const form = fresh.ok ? fresh.data : selected;
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("forms.back")}
        recordKey={
          form.recordSubtype ? `${form.recordKind} · ${form.recordSubtype}` : form.recordKind
        }
        title={form.name}
        state={templateState(form, t)}
        properties={[
          {
            label: t("forms.version"),
            value: form.version > 0 ? String(form.version) : t("forms.none"),
          },
          { label: t("forms.fieldCount"), value: String(form.fields.length) },
        ]}
        actions={templateActions(ctx, t, form, canPublish)}
      >
        {form.state === "Published" ? (
          <KitSection id="form-fill" title={t("forms.fill")}>
            <FormFiller
              org={ctx.org.slug}
              templateId={form.id}
              fields={form.fields}
              requiresSignature={form.requiresSignature}
              requiresLocation={form.requiresLocation}
              projects={(projects.ok ? projects.data : []).map((p) => ({
                value: p.id,
                label: `${p.key} ${p.name}`,
              }))}
            />
          </KitSection>
        ) : null}
        {canWrite && form.state === "Draft" ? (
          <KitSection id="form-edit" title={t("forms.edit")}>
            <EntityForm
              id={`form-edit-${form.id}`}
              action={updateFormAction}
              hidden={{ org: ctx.org.slug, id: form.id }}
              refusals={REFUSALS}
              submitLabel={t("forms.save")}
              fields={templateFields(form)}
            />
          </KitSection>
        ) : null}
      </RecordPage>
    );
  }

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("forms.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="form-create"
          action={createFormAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("forms.create")}
          successHref={withQuery(path, state, { peek: "{id}", full: "1" })}
          fields={templateFields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={
          selected.recordSubtype
            ? `${selected.recordKind} · ${selected.recordSubtype}`
            : selected.recordKind
        }
        title={selected.name}
        state={templateState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={[
          {
            label: t("forms.version"),
            value: selected.version > 0 ? String(selected.version) : t("forms.none"),
          },
          { label: t("forms.fieldCount"), value: String(selected.fields.length) },
          {
            label: t("forms.requiresSignature"),
            value: selected.requiresSignature ? t("yes") : t("no"),
          },
          {
            label: t("forms.requiresLocation"),
            value: selected.requiresLocation ? t("yes") : t("no"),
          },
        ]}
        actions={
          <>
            {selected.state === "Published" ? (
              <KitLink
                href={withQuery(path, state, { peek: selected.id, full: "1" })}
                variant="primary"
                size="sm"
              >
                {t("forms.fill")}
              </KitLink>
            ) : null}
            {templateActions(ctx, t, selected, canPublish)}
          </>
        }
      >
        {selected.description ? <p className="m-0 text-text-14">{selected.description}</p> : null}
        <ol className="m-0 flex flex-col gap-4 ps-16 text-text-13">
          {selected.fields.map((f) => (
            <li key={f.key}>
              {f.label}{" "}
              <span className="text-text-secondary">
                {t("forms.fieldMeta", {
                  kind: t(`forms.kinds.${f.kind}`),
                  required: f.required ? "yes" : "no",
                })}
              </span>
            </li>
          ))}
        </ol>
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = visible.map((f) => ({
    id: f.id,
    key: f.recordKind,
    title: f.name,
    state: templateState(f, t),
    meta: t("forms.fieldsLine", { count: f.fields.length }),
    cells: {
      name: f.name,
      kind: f.recordSubtype ? `${f.recordKind} · ${f.recordSubtype}` : f.recordKind,
      state: templateState(f, t),
      version: f.version > 0 ? f.version : null,
      submissions: submissions.data.filter((s) => s.templateId === f.id).length,
    },
  }));
  const createHref = withQuery(path, state, { create: "1" });
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "name", label: t("forms.name"), wrap: true },
        { key: "kind", label: t("forms.recordKind") },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "version", label: t("forms.version"), type: "number" },
        { key: "submissions", label: t("forms.submissions"), type: "number" },
      ]}
      rows={rows}
      actions={
        <div className="flex flex-wrap gap-8">
          {tabs}
          {canWrite ? (
            <KitLink href={createHref} variant="primary">
              {t("forms.create")}
            </KitLink>
          ) : null}
        </div>
      }
      empty={
        canWrite ? (
          <EmptyStateLink
            icon="ClipboardList"
            sentence={t("forms.empty")}
            actionLabel={t("forms.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="ClipboardList" sentence={t("forms.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}

function templateActions(ctx: OrgContext, t: Copy, f: FormTemplate, canPublish: boolean) {
  if (!canPublish) return null;
  return f.state === "Draft" ? (
    <ActionButton
      action={publishFormAction}
      hidden={{ org: ctx.org.slug, id: f.id }}
      label={t("forms.publish")}
      confirm={{ title: t("forms.publishTitle", { name: f.name }), body: t("forms.publishBody") }}
      refusals={REFUSALS}
    />
  ) : f.state === "Published" ? (
    <ActionButton
      action={retireFormAction}
      hidden={{ org: ctx.org.slug, id: f.id }}
      label={t("forms.retire")}
      variant="danger"
      reason={t("forms.retireReason")}
      refusals={REFUSALS}
    />
  ) : null;
}
