import { groupOutsideAccess, listOutsideAccess } from "@xos/data/outside-access";
import { InlineAlert } from "@/components/ui";
import type { ProjectContext } from "@/lib/projects/context";
import { getTranslate } from "@/lib/shell/translate";
import { OutsideAccessClient } from "./outside-access-client";

/**
 * Outside access (B2, ADR 0141; parity gap G-81): one section on Project Settings listing everything that reaches the
 * project from outside the org, grouped by source. It is a section, not a tab, because S4.5.4-01 fixes twenty project
 * tabs. Each source's own row level security decides what a member sees, and a control shows only to someone holding
 * the capability the source's RPC checks again. Nothing here is a code or token: XOS stores none readably.
 */
export async function OutsideAccessSection({ ctx }: { ctx: ProjectContext }) {
  const t = await getTranslate();
  const rows = await listOutsideAccess(ctx.org.viewer.db, ctx.project.id);
  const has = (code: string) => (ctx.capabilities as ReadonlySet<string>).has(code);
  return (
    <section
      id="outside-access"
      aria-labelledby="outside-access-title"
      className="flex flex-col gap-16"
    >
      <header className="flex flex-col gap-4">
        <h2 id="outside-access-title" className="m-0 text-heading-16 font-semibold">
          {t("projects.outsideAccess.title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("projects.outsideAccess.description")}
        </p>
      </header>
      {rows.ok ? (
        <OutsideAccessClient
          refs={{ org: ctx.org.org.slug, projectKey: ctx.project.key }}
          timeZone={ctx.project.timeZone}
          groups={groupOutsideAccess(rows.data)}
          can={{
            packs: has("projects.settings.write"),
            live: has("show.run_of_show.write") || has("schedule.timeline.export"),
            advance: has("advancing.packet.send"),
            engagement: has("opportunities.engagement.write"),
            forms: has("knowledge.sop.publish"),
          }}
        />
      ) : (
        <InlineAlert tone="danger">{t("projects.outsideAccess.loadError")}</InlineAlert>
      )}
    </section>
  );
}
