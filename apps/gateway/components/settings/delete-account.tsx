import { previewAccountDeletion, type KeptCategory } from "@xos/data/account-deletion";
import { untyped } from "@xos/data/untyped";
import { LoadError } from "@/components/ui";
import type { GatewayContext } from "@/lib/shell/context";
import type { Translate } from "@/lib/shell/translate";
import { DeleteAccountForm } from "./delete-account-form";

const KEPT: readonly KeptCategory[] = [
  "time_and_pay",
  "tax_forms",
  "engagements",
  "org_records",
  "audit_trail",
  "erasure_request",
];

/**
 * Settings, Account: delete the account (ADR 0028, journey 38). The same preview, refusals and
 * kept-records copy as Compass (compass.account): what blocks deletion, what is kept and why, then
 * the confirmation. Online only, so the preview is read on every visit.
 */
export async function DeleteAccountSection({ ctx, t }: { ctx: GatewayContext; t: Translate }) {
  const preview = await previewAccountDeletion(untyped(ctx.db));
  return (
    <section
      aria-labelledby="delete-account-title"
      className="flex flex-col gap-12 rounded-card border border-border-subtle p-16"
    >
      <h2 id="delete-account-title" className="m-0 text-heading-16 font-semibold">
        {t("compass.account.title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("compass.account.intro")}</p>
      {!preview.ok ? (
        <LoadError
          title={t("compass.account.previewFailedTitle")}
          sentence={t("compass.account.previewFailed", {
            reason: "message" in preview.error ? preview.error.message : preview.error.kind,
          })}
          actionLabel={t("compass.account.retry")}
        />
      ) : (
        <>
          {preview.data.blockers.length > 0 ? (
            <div className="flex flex-col gap-8">
              <h3 className="m-0 text-text-14 font-semibold">
                {t("compass.account.blockersTitle")}
              </h3>
              <ul
                className="m-0 flex list-none flex-col gap-8 p-0"
                aria-label={t("compass.account.blockersTitle")}
              >
                {preview.data.blockers.map((b) => (
                  <li
                    key={`${b.code}-${b.orgId}`}
                    className="rounded-card border border-border-subtle bg-bg-raised p-12 text-text-13"
                  >
                    <strong className="block">{b.orgName}</strong>
                    {t(`compass.account.blocker.${b.code}`, {
                      org: b.orgName,
                      matter: b.matter ?? "",
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-4">
            <h3 className="m-0 text-text-14 font-semibold">{t("compass.account.keptTitle")}</h3>
            <ul className="m-0 flex list-disc flex-col gap-4 ps-20 text-text-13 text-text-secondary">
              {preview.data.kept.map((k) => (
                <li key={k.category}>{t(`compass.account.kept.${k.category}`)}</li>
              ))}
            </ul>
          </div>
          {preview.data.blockers.length === 0 ? (
            <DeleteAccountForm
              email={preview.data.email}
              copy={{
                emailLabel: t("compass.account.emailLabel"),
                emailHelp: t("compass.account.emailHelp", { email: preview.data.email }),
                emailMismatch: t("compass.account.emailMismatch"),
                delete: t("compass.account.delete"),
                confirmTitle: t("gateway.settings.deleteAccount.confirmTitle"),
                confirmBody: t("gateway.settings.deleteAccount.confirmBody"),
                cancel: t("gateway.settings.deleteAccount.cancel"),
                refusedTitle: t("compass.account.refusedTitle"),
                failed: t("compass.account.failed", { reason: "{reason}" }),
                doneTitle: t("compass.account.doneTitle"),
                doneSentence: t("compass.account.doneSentence", { count: "{count}" }),
                keptTitle: t("compass.account.keptTitle"),
                kept: Object.fromEntries(KEPT.map((k) => [k, t(`compass.account.kept.${k}`)])),
                done: t("compass.account.done"),
              }}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
