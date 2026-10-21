import { listRoles } from "@xos/data";
import { listObjectTypes } from "@xos/data/custom-objects";
import { canExportOrg, daysUntil, getCancellation, listOrgExports } from "@xos/data/lifecycle";
import { dayOf, purgeDay } from "@xos/data/org-lifecycle";
import { getPartnerOf, listSupportSessions } from "@xos/data/partner";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StepUpDownloadLink } from "@/components/auth/security/step-up-download";
import { InlineAlert } from "@/components/ui";
import {
  AddFieldForm,
  CancelOrganizationForm,
  CreateObjectTypeForm,
  EndSupportSessionForm,
  GrantSupportSessionForm,
  ReactivateOrganizationForm,
  ViewAsForm,
} from "@/components/platform/settings-forms";
import { getFormatters } from "@/lib/platform/format";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A36's settings panels (ADR 0021 item 7):
 *   Settings, Security                 support sessions a client org's Owner grants its partner (Section 4.6.1)
 *   Settings, Custom objects           define custom objects and their fields (Section 4.6.3)
 *   Settings, Roles and capabilities   View as role (Section 8.4)
 *   Settings, Danger zone              cancel the org, the full export and reactivation (Section 14.7)
 * Each panel reads with the viewer's client, so row level security decides what appears; the RPCs
 * decide every change.
 */

/** The public API route of a custom object (Section 4.6.3). */
const apiRoute = (key: string) => ["", "api", "v1", "objects", key].join("/");

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

async function SupportSessionsPanel({ ctx }: SettingsPanelProps) {
  const { t, dateTime } = await getFormatters(ctx);
  const partner = await getPartnerOf(ctx.viewer.db, ctx.org.id);
  if (partner.ok && partner.data === null) return null;
  const sessions = await listSupportSessions(ctx.viewer.db, ctx.org.id);
  const owner = ctx.capabilities.has("org.support_session.grant");
  const open = sessions.ok ? sessions.data.find((s) => s.open) : undefined;
  return (
    <section aria-labelledby="support-sessions" className="flex flex-col gap-12">
      <Heading
        id="support-sessions"
        title={t("access.support.title")}
        description={t("access.support.description")}
      />
      {!partner.ok || !sessions.ok ? (
        <InlineAlert tone="danger">{t("access.support.loadError")}</InlineAlert>
      ) : (
        <>
          {open ? (
            <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
              <p className="m-0 text-text-13">
                {t("access.support.open", { when: dateTime(open.endsAt), reason: open.reason })}
              </p>
              {owner ? <EndSupportSessionForm org={ctx.org.slug} session={open.id} /> : null}
            </div>
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("access.support.none")}</p>
          )}
          {owner && !open ? <GrantSupportSessionForm org={ctx.org.slug} /> : null}
          {!owner ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("access.support.ownerOnly")}</p>
          ) : null}
          {sessions.data.filter((s) => !s.open).length > 0 ? (
            <ul
              className="m-0 flex list-none flex-col gap-4 p-0"
              aria-label={t("access.support.history")}
            >
              {sessions.data
                .filter((s) => !s.open)
                .map((s) => (
                  <li key={s.id} className="text-text-12 text-text-secondary">
                    {t("access.support.past", {
                      from: dateTime(s.startsAt),
                      to: dateTime(s.endedAt ?? s.endsAt),
                      reason: s.reason,
                    })}
                  </li>
                ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

async function CustomObjectsPanel({ ctx }: SettingsPanelProps) {
  const { t } = await getFormatters(ctx);
  const types = await listObjectTypes(ctx.viewer.db, ctx.org.id);
  const editable = ctx.capabilities.has("org.custom_objects.write");
  return (
    <section aria-labelledby="custom-objects" className="flex flex-col gap-16">
      <Heading
        id="custom-objects"
        title={t("objects.define.heading")}
        description={t("objects.define.description")}
      />
      {!types.ok ? (
        <InlineAlert tone="danger">{t("objects.loadError")}</InlineAlert>
      ) : (
        <>
          {types.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("objects.define.none")}</p>
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-16 p-0"
              aria-label={t("objects.define.heading")}
            >
              {types.data.map((type) => (
                <li
                  key={type.id}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                >
                  <div className="flex flex-wrap items-center justify-between gap-8">
                    <h3 className="m-0 text-text-14 font-semibold">{type.label}</h3>
                    <Link
                      href={`/${ctx.org.slug}/objects/${type.key}` as Route}
                      className="text-text-13 text-accent-text underline"
                    >
                      {t("objects.define.open", { object: type.label })}
                    </Link>
                  </div>
                  <p className="m-0 font-mono text-text-12 text-text-tertiary">
                    {apiRoute(type.key)}
                  </p>
                  {type.fields.length > 0 ? (
                    <ul
                      className="m-0 flex list-none flex-wrap gap-8 p-0"
                      aria-label={t("objects.define.fields", { object: type.label })}
                    >
                      {type.fields.map((f) => (
                        <li
                          key={f.id}
                          className="rounded-control border border-border-subtle px-8 py-2 text-text-12"
                        >
                          {f.label} · {t(`objects.dataTypes.${f.dataType}`)}
                          {f.required ? ` · ${t("objects.field.requiredShort")}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("objects.define.noFields")}
                    </p>
                  )}
                  {editable ? (
                    <details>
                      <summary className="cursor-pointer text-text-13 font-medium">
                        {t("objects.field.title", { object: type.label })}
                      </summary>
                      <div className="pt-8">
                        <AddFieldForm
                          org={ctx.org.slug}
                          typeId={type.id}
                          label={type.label}
                          next={type.fields.length + 1}
                        />
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {editable ? (
            <div className="flex flex-col gap-8">
              <h3 className="m-0 text-text-14 font-semibold">{t("objects.define.title")}</h3>
              <CreateObjectTypeForm org={ctx.org.slug} />
            </div>
          ) : (
            <p className="m-0 text-text-12 text-text-secondary">{t("objects.define.readOnly")}</p>
          )}
        </>
      )}
    </section>
  );
}

async function ViewAsPanel({ ctx }: SettingsPanelProps) {
  const { t } = await getFormatters(ctx);
  const shell = (await getTranslations("shell")) as unknown as (k: string) => string;
  if (!ctx.capabilities.has("org.view_as_role.use") && !ctx.preview) return null;
  const roles = await listRoles(ctx.viewer.db, ctx.org.id);
  const own = ctx.org.bestBand ?? 8;
  return (
    <section aria-labelledby="view-as" className="flex flex-col gap-12">
      <Heading
        id="view-as"
        title={t("access.viewAs.title")}
        description={t("access.viewAs.description")}
      />
      {ctx.preview ? (
        <p className="m-0 text-text-13">{t("access.viewAs.active")}</p>
      ) : !roles.ok ? (
        <InlineAlert tone="danger">{t("access.viewAs.loadError")}</InlineAlert>
      ) : (
        <ViewAsForm
          org={ctx.org.slug}
          roles={roles.data
            .filter((r) => r.band > own)
            .map((r) => ({
              value: r.id,
              label: r.system ? shell(`roles.${r.code}`) : (r.name ?? r.code),
            }))}
        />
      )}
    </section>
  );
}

async function DangerZonePanel({ ctx }: SettingsPanelProps) {
  const [{ t, dateTime, date }, zone] = await Promise.all([
    getFormatters(ctx),
    getOrgTimeZone(ctx),
  ]);
  const [cancellation, canExport, exports] = await Promise.all([
    getCancellation(ctx.viewer.db, ctx.org.id),
    canExportOrg(ctx.viewer.db, ctx.org.id),
    listOrgExports(ctx.viewer.db, ctx.org.id),
  ]);
  const owner = ctx.capabilities.has("org.organization.delete") || (canExport.ok && canExport.data);
  return (
    <section aria-labelledby="org-cancel" className="flex flex-col gap-12">
      <Heading
        id="org-cancel"
        title={t("lifecycle.title")}
        description={t("lifecycle.description")}
      />
      {!cancellation.ok ? (
        <InlineAlert tone="danger">{t("lifecycle.loadError")}</InlineAlert>
      ) : cancellation.data ? (
        <div className="flex flex-col gap-12">
          <InlineAlert tone="warning" title={t("lifecycle.canceled.title")}>
            {t("lifecycle.canceled.body", {
              days: daysUntil(cancellation.data.readOnlyUntil),
              // Days on the org's calendar; data is deleted from its midnight on day 90 (A79, 1351).
              until: date(dayOf(cancellation.data.readOnlyUntil, zone)),
              purge: date(purgeDay(cancellation.data.canceledAt, zone)),
            })}
          </InlineAlert>
          {owner ? (
            <>
              <StepUpDownloadLink
                href={`/${ctx.org.slug}/export`}
                className="inline-flex h-control-md w-fit items-center rounded-control border border-border-control px-12 text-text-13 font-medium hover:bg-bg-hover"
              >
                {t("lifecycle.export.download")}
              </StepUpDownloadLink>
              <p className="m-0 text-text-12 text-text-secondary">{t("lifecycle.export.help")}</p>
              {daysUntil(cancellation.data.readOnlyUntil) > 0 ? (
                <ReactivateOrganizationForm org={ctx.org.slug} />
              ) : null}
            </>
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("lifecycle.ownerOnly")}</p>
          )}
        </div>
      ) : owner ? (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13">{t("lifecycle.cancel.explain")}</p>
          <StepUpDownloadLink
            href={`/${ctx.org.slug}/export`}
            className="inline-flex h-control-md w-fit items-center rounded-control border border-border-control px-12 text-text-13 font-medium hover:bg-bg-hover"
          >
            {t("lifecycle.export.download")}
          </StepUpDownloadLink>
          <CancelOrganizationForm org={ctx.org.slug} name={ctx.org.name} />
        </div>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("lifecycle.ownerOnly")}</p>
      )}
      {exports.ok && exports.data.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0"
          aria-label={t("lifecycle.export.history")}
        >
          {exports.data.map((e) => (
            <li key={e.id} className="text-text-12 text-text-secondary">
              {t("lifecycle.export.past", {
                when: dateTime(e.createdAt),
                tables: e.tableCount,
                rows: e.rowCount,
                files: e.fileCount,
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.security", order: 40, Panel: SupportSessionsPanel },
  { node: "settings.custom-objects", order: 10, Panel: CustomObjectsPanel },
  { node: "settings.roles-and-capabilities", order: 30, Panel: ViewAsPanel },
  { node: "settings.danger-zone", order: 10, Panel: DangerZonePanel },
];
