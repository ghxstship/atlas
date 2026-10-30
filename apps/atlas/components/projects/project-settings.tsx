"use client";

import type { ProjectMember, ProjectSummary } from "@xos/data/projects";
import { Button, Dialog, InlineAlert, Select, StateChip } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addMemberAction,
  archiveProjectAction,
  endMemberAction,
  updateProjectAction,
} from "@/lib/projects/actions";
import { enumKey, stateIcon } from "@/lib/projects/format";
import { ActionError, echoed, useClosingAction } from "./action-error";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { ProjectFields, type ProjectFormOptions } from "./project-fields";
import { TransitionDialog } from "./transition-dialog";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
interface Base {
  readonly org: string;
  readonly projectKey: string;
}

function Hidden({ org, projectKey }: Base) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectKey" value={projectKey} />
    </>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-12 border-t border-border-subtle pt-20 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{lead}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Project Settings (Section 4.5.4, Settings template column): the key, name, place and dates; the
 * lifecycle moves; project members and roles; archive and restore; and where Gateway access lives.
 * Controls appear only for holders of the capability; the database decides every write.
 */
export function ProjectSettings({
  org,
  project,
  options,
  members,
  candidates,
  moves,
  canSettings,
  canWrite,
  canMembers,
  canArchive,
  roles,
  engagementsHref,
}: {
  org: string;
  project: ProjectSummary;
  options: ProjectFormOptions;
  members: readonly ProjectMember[];
  candidates: readonly { readonly value: string; readonly label: string }[];
  moves: { readonly project: readonly string[]; readonly production: readonly string[] };
  canSettings: boolean;
  canWrite: boolean;
  canMembers: boolean;
  canArchive: boolean;
  roles: readonly string[];
  engagementsHref: string | null;
}) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const [state, action, pending] = useActionState(updateProjectAction, {});
  const base = { org, projectKey: project.key };
  const editable = canWrite || canSettings;

  return (
    <div className="flex max-w-layout-form flex-col gap-24">
      {!editable && !canMembers ? (
        <InlineAlert tone="info">{t("settings.readOnly")}</InlineAlert>
      ) : null}

      <Section id="settings-general" title={t("settings.general")} lead={t("settings.generalLead")}>
        <form
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-col gap-12"
          noValidate
        >
          <Hidden {...base} />
          <ActionError state={state} />
          <ProjectFields
            idPrefix="settings"
            options={options}
            state={state}
            disabled={!editable}
            values={{
              key: project.key,
              name: project.name,
              timeZone: project.timeZone,
              jurisdictionId: project.jurisdictionId,
              tierCode: project.tierCode,
              regionCode: project.regionCode,
              venueId: project.venueId,
              startsOn: project.startsOn,
              endsOn: project.endsOn,
              currencyCode: project.currency,
              description: project.description,
            }}
          />
          {editable ? (
            <div className="flex items-center gap-12">
              <Button type="submit" variant="primary" loading={pending}>
                {t("settings.save")}
              </Button>
              {state.ok ? (
                <p role="status" className="m-0 text-text-13 text-success-text">
                  {t("settings.saved")}
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      </Section>

      <CustomFieldsSection table="app.projects" id={project.id} />

      <Section
        id="settings-lifecycle"
        title={t("settings.lifecycle")}
        lead={t("settings.lifecycleLead")}
      >
        <dl className="m-0 grid grid-cols-[var(--ui-props-label)_1fr] items-center gap-x-16 gap-y-12">
          <dt className="text-text-12 text-text-secondary">{t("fields.state")}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-8">
            <StateChip
              state={stateIcon(project.projectState)}
              label={t(`states.${project.projectState}`)}
            />
            {canSettings ? (
              <TransitionDialog
                {...base}
                lifecycle="project"
                current={project.projectState}
                allowed={moves.project}
              />
            ) : null}
          </dd>
          <dt className="text-text-12 text-text-secondary">{t("fields.production")}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-8">
            <StateChip
              state={stateIcon(project.productionState)}
              label={t(`states.${project.productionState}`)}
            />
            {canSettings ? (
              <TransitionDialog
                {...base}
                lifecycle="production"
                current={project.productionState}
                allowed={moves.production}
              />
            ) : null}
          </dd>
        </dl>
      </Section>

      <Section id="settings-members" title={t("settings.members")} lead={t("settings.membersLead")}>
        {members.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("settings.noMembers")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col">
                  <span className="text-text-14 text-text-primary">
                    {m.fullName ?? t("settings.unnamed")}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`roles.${enumKey(m.role)}` as "roles.field")} ·{" "}
                    {t("settings.since", {
                      date: format.dateTime(new Date(m.validFrom), { dateStyle: "medium" }),
                    })}
                  </span>
                </span>
                {canMembers ? <EndMemberDialog {...base} member={m} /> : null}
              </li>
            ))}
          </ul>
        )}
        {canMembers ? (
          candidates.length > 0 ? (
            <AddMemberDialog {...base} candidates={candidates} roles={roles} />
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("settings.noCandidates")}</p>
          )
        ) : null}
      </Section>

      {engagementsHref ? (
        <Section
          id="settings-gateway"
          title={t("settings.gateway")}
          lead={t("settings.gatewayLead")}
        >
          <p className="m-0">
            <Link
              href={engagementsHref as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("settings.gatewayLink")}
            </Link>
          </p>
        </Section>
      ) : null}

      {canArchive ? (
        <Section
          id="settings-archive"
          title={t("settings.archive")}
          lead={t("settings.archiveLead")}
        >
          <ArchiveDialog {...base} archived={project.archivedAt !== null} />
        </Section>
      ) : null}
    </div>
  );
}

function AddMemberDialog({
  org,
  projectKey,
  candidates,
  roles,
}: Base & {
  candidates: readonly { readonly value: string; readonly label: string }[];
  roles: readonly string[];
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(addMemberAction, () => setOpen(false));
  return (
    <div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button size="sm" variant="secondary" icon="UserPlus">
            {t("settings.add")}
          </Button>
        }
        title={t("settings.addTitle")}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("scope.cancel")}
            </Button>
            <Button type="submit" form="add-member" variant="primary" loading={pending}>
              {t("settings.add")}
            </Button>
          </>
        }
      >
        <form
          id="add-member"
          action={action}
          onSubmit={keepInputOnSubmit(action)}
          className="flex flex-col gap-12"
          noValidate
        >
          <Hidden org={org} projectKey={projectKey} />
          <ActionError state={state} />
          <Select
            id="member-person"
            name="membershipId"
            label={t("settings.person")}
            value={echoed(state, "membershipId", candidates[0]?.value ?? "")}
            options={[...candidates]}
          />
          <Select
            id="member-role"
            name="role"
            label={t("settings.role")}
            value={echoed(state, "role", roles[2] ?? roles[0] ?? "")}
            options={roles.map((r) => ({
              value: r,
              label: t(`roles.${enumKey(r)}` as "roles.field"),
            }))}
          />
        </form>
      </Dialog>
    </div>
  );
}

function EndMemberDialog({ org, projectKey, member }: Base & { member: ProjectMember }) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(endMemberAction, () => setOpen(false));
  const name = member.fullName ?? t("settings.unnamed");
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost" aria-label={`${t("settings.remove")} ${name}`}>
          {t("settings.remove")}
        </Button>
      }
      title={t("settings.removeAction")}
      description={t("settings.removeConfirm", { name, key: projectKey })}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("scope.cancel")}
          </Button>
          <Button type="submit" form={`end-${member.id}`} variant="danger" loading={pending}>
            {t("settings.removeAction")}
          </Button>
        </>
      }
    >
      <form id={`end-${member.id}`} action={action} onSubmit={keepInputOnSubmit(action)}>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="projectMemberId" value={member.id} />
        <ActionError state={state} />
      </form>
    </Dialog>
  );
}

function ArchiveDialog({ org, projectKey, archived }: Base & { archived: boolean }) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(archiveProjectAction, () => setOpen(false));
  if (archived) {
    return (
      <form action={action} onSubmit={keepInputOnSubmit(action)}>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="archived" value="false" />
        <ActionError state={state} />
        <Button type="submit" variant="secondary" loading={pending}>
          {t("settings.restoreAction")}
        </Button>
      </form>
    );
  }
  return (
    <div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={<Button variant="danger">{t("settings.archiveAction")}</Button>}
        title={t("settings.archiveAction")}
        description={t("settings.archiveConfirm", { key: projectKey })}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("scope.cancel")}
            </Button>
            <Button type="submit" form="archive-project" variant="danger" loading={pending}>
              {t("settings.archiveAction")}
            </Button>
          </>
        }
      >
        <form id="archive-project" action={action} onSubmit={keepInputOnSubmit(action)}>
          <Hidden org={org} projectKey={projectKey} />
          <input type="hidden" name="archived" value="true" />
          <ActionError state={state} />
        </form>
      </Dialog>
    </div>
  );
}
