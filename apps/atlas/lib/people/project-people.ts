import {
  listEngagementOptions,
  listProjectPeople,
  type EngagementOption,
  type ProjectPerson,
} from "@xos/data/project-people";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";
import type { Translate } from "@/lib/shell/translate";

/**
 * People pickers that reach a project's engaged people (R1, migration 2600). Server components and
 * actions read the project's members and engaged people once per request; a viewer without a people
 * picker capability on the project gets an empty list, as the database decides.
 */
export const projectPeople = cache(
  async (ctx: OrgContext, projectId: string): Promise<readonly ProjectPerson[]> => {
    const people = await listProjectPeople(ctx.viewer.db, projectId);
    return people.ok ? people.data : [];
  },
);

/** The live engagements of the org's projects the viewer reaches, read once per request. */
export const engagementOptions = cache(
  async (ctx: OrgContext, projectId?: string): Promise<readonly EngagementOption[]> => {
    const options = await listEngagementOptions(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: projectId ?? null,
    });
    return options.ok ? options.data : [];
  },
);

/**
 * A picker label: a member's name, or an engaged non-member's name with the account that supplies
 * them or, without one, their role type.
 */
export function projectPersonLabel(t: Translate, person: ProjectPerson, unnamed: string): string {
  const name = person.fullName || unnamed;
  if (person.membershipId || !person.engagementId) return name;
  const party =
    person.accountName ?? (person.roleType ? t(`people.roleTypes.${person.roleType}`) : "");
  return party ? t("credentials.issued.holderEngaged", { name, party }) : name;
}

/** Names by person id, for guest, traveller and worker columns. */
export function projectPeopleNames(people: readonly ProjectPerson[]): Map<string, string> {
  return new Map(people.map((p) => [p.personId, p.fullName]));
}
