import { resolveSettings } from "@xos/data/settings";
import { listSharedSupplierDiversity } from "@xos/data/supplier-diversity";
import { getFormatter } from "next-intl/server";
import type { Route } from "next";
import Link from "next/link";
import { ErrorPanel } from "@/components/collection-kit/kit";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";
import { supplierDiversityProgramOn } from "@/lib/shell/org-settings";
import { SupplierDiversityReveal } from "./supplier-diversity-reveal";

/**
 * Supplier diversity certifications vendors and freelancers shared with the org (Section 4.4.1, migration
 * 1464), under Vendors, Directory. Only while the org runs a program (gateway.supplier_diversity_program),
 * only for members holding vendors.vendor.read, and every read is logged in each owner's access log and the
 * org's audit ledger. The certificate number is a Restricted government identifier (Section 8.3), encrypted at
 * rest (2011): every reader sees its last four characters, and a member holding
 * data.restricted.read.government_id reveals the whole number with a reason and step-up (decision 38).
 */
export async function SharedSupplierDiversity({ ctx }: { ctx: OrgContext }) {
  if (!ctx.capabilities.has("vendors.vendor.read")) return null;
  const db = ctx.viewer.db;
  const [t, format, settings] = await Promise.all([
    getCopy("vendors"),
    getFormatter(),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  const on = supplierDiversityProgramOn((key) =>
    settings.ok ? settings.data.get(key)?.value : undefined,
  );
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00`), { dateStyle: "medium" });
  return (
    <section aria-labelledby="supplier-diversity" className="flex flex-col gap-12">
      <h2 id="supplier-diversity" className="m-0 text-heading-16 font-semibold">
        {t("diversity.title")}
      </h2>
      {!on ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("diversity.off")}{" "}
          {ctx.capabilities.has("org.gateway.write") ? (
            <Link
              href={`/${ctx.org.slug}/settings/gateway-and-marketplace` as Route}
              className="text-accent-text underline"
            >
              {t("diversity.turnOn")}
            </Link>
          ) : null}
        </p>
      ) : (
        <SharedList ctx={ctx} date={date} t={t} />
      )}
    </section>
  );
}

/** The catalog key of a kind: `Service-Disabled Veteran-Owned` becomes `serviceDisabledVeteranOwned`. */
function kindKey(kind: string): string {
  return kind
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

async function SharedList({
  ctx,
  date,
  t,
}: {
  ctx: OrgContext;
  date: (d: string) => string;
  t: Copy;
}) {
  const shared = await listSharedSupplierDiversity(ctx.viewer.db, ctx.org.id);
  if (!shared.ok) return <ErrorPanel what={t("diversity.what")} />;
  if (shared.data.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("diversity.empty")}</p>;
  }
  const revealable = ctx.capabilities.has("data.restricted.read.government_id")
    ? shared.data.flatMap((s) =>
        s.numberLast4
          ? [
              {
                value: s.shareId,
                label: t("diversity.revealOption", {
                  owner: s.ownerName,
                  kind: t(`diversity.kinds.${kindKey(s.kind)}`),
                  last4: s.numberLast4,
                }),
              },
            ]
          : [],
      )
    : [];
  return (
    <>
      <p className="m-0 text-text-13 text-text-secondary">{t("diversity.lead")}</p>
      <table className="w-full border-collapse text-text-13">
        <thead>
          <tr className="text-start text-text-secondary">
            <th scope="col" className="py-6 text-start font-medium">
              {t("diversity.owner")}
            </th>
            <th scope="col" className="py-6 text-start font-medium">
              {t("diversity.kind")}
            </th>
            <th scope="col" className="py-6 text-start font-medium">
              {t("diversity.certifyingBody")}
            </th>
            <th scope="col" className="py-6 text-start font-medium">
              {t("diversity.number")}
            </th>
            <th scope="col" className="py-6 text-start font-medium">
              {t("diversity.expires")}
            </th>
          </tr>
        </thead>
        <tbody>
          {shared.data.map((s) => (
            <tr key={s.shareId} className="border-t border-border-subtle">
              <td className="py-6">{s.ownerName}</td>
              <td className="py-6">{t(`diversity.kinds.${kindKey(s.kind)}`)}</td>
              <td className="py-6">{s.certifyingBody}</td>
              <td className="py-6 tabular-nums">
                {s.numberLast4
                  ? t("diversity.masked", { last4: s.numberLast4 })
                  : t("diversity.none")}
              </td>
              <td className="py-6">{s.expiresOn ? date(s.expiresOn) : t("diversity.none")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {revealable.length > 0 ? (
        <SupplierDiversityReveal org={ctx.org.slug} options={revealable} />
      ) : null}
    </>
  );
}
