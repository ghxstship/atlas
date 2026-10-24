import {
  listCertificationHolders,
  listDirectory,
  listRoleAssignments,
  seatSplit,
} from "@xos/data/people";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { createAssignmentAction } from "@/app/[org]/people/actions";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { Avatar, InlineAlert } from "@/components/crew/ui";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, getProjects, withParams } from "@/lib/crew/context";
import { workforceRoles } from "@/lib/people/roles";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * People > Directory (Section 4.5.5): the org's members with their roles, role assignments and
 * certifications, in table, list and gallery views. Seats count members above Field; Field members
 * are metered separately (Section 16). A Field member sees only their own row (Section 4.5.9).
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/directory">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.directory";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const result = await listDirectory(db, crew.orgId);
  if (!result.ok) throw new Error(`Cannot list the directory: ${result.error.kind}`);
  const all = result.data;
  const query = (search["q"] ?? "").trim().toLowerCase();
  const people = query ? all.filter((p) => (p.name ?? "").toLowerCase().includes(query)) : all;
  const split = seatSplit(all);
  const canAssign = crew.can("people.role.write");
  const roleLabel = (code: string, name: string | null) => name ?? t(`shell.roles.${code}`);
  const name = (n: string | null) => n ?? t("crew.common.unnamed");

  let peek = null;
  if (search["peek"]) {
    const person = all.find((p) => p.membershipId === search["peek"]);
    if (person && person.personId) {
      const roles = await workforceRoles(crew.ctx);
      const [assignments, certificates] = await Promise.all([
        listRoleAssignments(db, { orgId: crew.orgId, personId: person.personId }),
        listCertificationHolders(db, { orgId: crew.orgId, personId: person.personId }),
      ]);
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          kindLabel={t("people.kinds.person")}
          recordKey={person.roles[0] ? roleLabel(person.roles[0].code, person.roles[0].name) : ""}
          title={name(person.name)}
          state="active"
          stateLabel={t("people.directory.active")}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            canAssign ? (
              <ButtonLink href={withParams(base, search, { assign: person.personId })} size="sm">
                {t("people.assignments.assign")}
              </ButtonLink>
            ) : null
          }
          properties={[
            {
              label: t("people.directory.roles"),
              value:
                person.roles.map((r) => roleLabel(r.code, r.name)).join(", ") ||
                t("people.directory.noRole"),
            },
            {
              label: t("people.directory.since"),
              value: format.dateTime(new Date(person.validFrom), { dateStyle: "medium" }),
            },
          ]}
        >
          <section aria-labelledby="person-assignments" className="flex flex-col gap-8">
            <h2 id="person-assignments" className="m-0 text-text-13 font-semibold">
              {t("people.directory.assignments")}
            </h2>
            {assignments.ok && assignments.data.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                {assignments.data.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/${crew.slug}/people/roles?peek=${a.roleCode}` as Route}
                      className="text-accent-text underline"
                    >
                      {t("people.directory.assignmentLine", {
                        project: a.projectKey,
                        role: roles.get(a.roleCode)?.role ?? a.roleCode,
                        state: t(`people.states.assignment.${a.state}`),
                      })}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("people.directory.noAssignments")}
              </p>
            )}
          </section>
          <section aria-labelledby="person-certs" className="flex flex-col gap-8">
            <h2 id="person-certs" className="m-0 text-text-13 font-semibold">
              {t("nav.atlas.pages.people.certifications")}
            </h2>
            {certificates.ok && certificates.data.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                {certificates.data.map((c) => (
                  <li key={c.id}>
                    {t("people.directory.certLine", {
                      name: c.certificationName,
                      expires: c.expiresOn ?? t("people.certs.noExpiry"),
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("people.directory.noCerts")}
              </p>
            )}
          </section>
        </CrewRecord>
      );
      if (search["full"] === "1") return record;
      peek = record;
    }
  }

  let drawer = null;
  if (search["assign"] && canAssign) {
    const [projects, roles] = await Promise.all([getProjects(crew.ctx), workforceRoles(crew.ctx)]);
    drawer = (
      <DrawerForm
        title={t("people.assignments.assignTitle")}
        submitLabel={t("people.assignments.assign")}
        action={createAssignmentAction}
        openKeys={["assign"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "personId", value: search["assign"] },
          {
            kind: "select",
            name: "projectId",
            label: t("crew.fields.project"),
            options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
          },
          {
            kind: "select",
            name: "roleCode",
            label: t("people.roles.workforceRole"),
            options: [...roles.values()].map((r) => ({
              value: r.code,
              label: `${r.code} · ${r.role}`,
            })),
          },
          {
            kind: "select",
            name: "staffingBasis",
            label: t("people.assignments.basis"),
            value: "Declared",
            help: t("people.assignments.basisHelp"),
            options: ["Declared", "Ratio", "Fixed"].map((b) => ({
              value: b,
              label: t(`people.basis.${b}`),
            })),
          },
          { kind: "date", name: "startsOn", label: t("people.assignments.startsOn") },
          { kind: "date", name: "endsOn", label: t("people.assignments.endsOn") },
        ]}
      />
    );
  }

  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });
  let body;
  if (people.length === 0) {
    body = (
      <EmptyStateLink
        icon="Users"
        sentence={query ? t("people.directory.noMatch") : t("people.directory.empty")}
        actionLabel={query ? t("crew.common.clearFilter") : t("people.directory.invite")}
        href={query ? withParams(base, search, { q: null }) : `/${crew.slug}/settings/members`}
      />
    );
  } else if (view === "gallery") {
    body = (
      <ul
        aria-label={t("people.directory.caption")}
        className="m-0 grid list-none grid-cols-1 gap-12 p-0 sm:grid-cols-3 lg:grid-cols-4"
      >
        {people.map((p) => (
          <li key={p.membershipId}>
            <Link
              href={peekHref(p.membershipId) as Route}
              className="flex flex-col items-start gap-8 rounded-card border border-border-subtle p-12 hover:bg-bg-hover"
            >
              <Avatar name={name(p.name)} size="lg" />
              <span className="text-text-13 font-medium">{name(p.name)}</span>
              <span className="text-text-12 text-text-secondary">
                {p.roles[0]
                  ? roleLabel(p.roles[0].code, p.roles[0].name)
                  : t("people.directory.noRole")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("people.directory.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {people.map((p) => (
          <li key={p.membershipId}>
            <Link
              href={peekHref(p.membershipId) as Route}
              className="flex items-center gap-12 px-12 py-8 hover:bg-bg-hover"
            >
              <Avatar name={name(p.name)} />
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{name(p.name)}</span>
                <span className="text-text-12 text-text-secondary">
                  {p.roles[0]
                    ? roleLabel(p.roles[0].code, p.roles[0].name)
                    : t("people.directory.noRole")}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("people.directory.caption")}
        columns={[
          { key: "name", label: t("crew.fields.person") },
          { key: "role", label: t("people.directory.roles") },
          { key: "assignments", label: t("people.directory.assignments"), type: "number" },
          {
            key: "certifications",
            label: t("nav.atlas.pages.people.certifications"),
            type: "number",
          },
          { key: "since", label: t("people.directory.since") },
        ]}
        rows={people.map((p) => ({
          id: p.membershipId,
          name: name(p.name),
          role: p.roles.map((r) => roleLabel(r.code, r.name)).join(", "),
          assignments: p.assignments,
          certifications: p.certifications,
          since: format.dateTime(new Date(p.validFrom), { dateStyle: "medium" }),
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
      count={people.length}
      view={view}
      {...(crew.canAll("people.directory.read")
        ? {
            actions: (
              <ButtonLink href={`/${crew.slug}/settings/members`} size="sm">
                {t("people.directory.invite")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <form className="flex items-end gap-8" role="search">
          {Object.entries(search)
            .filter(([k, v]) => k !== "q" && v !== undefined)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("people.directory.search")}</span>
            <input
              name="q"
              defaultValue={search["q"] ?? ""}
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary"
            />
          </label>
        </form>
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {crew.canAll("people.directory.read") ? (
        <InlineAlert
          tone="info"
          title={t("people.directory.seatsTitle", { seats: split.seats, field: split.field })}
        >
          {t("people.directory.seatsBody")}
        </InlineAlert>
      ) : null}
      {body}
    </CrewFrame>
  );
}
