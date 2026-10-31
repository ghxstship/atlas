import { showcallerAsksForCode, type ShowcallerRefusal } from "@xos/data/showcaller-links";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert, Input } from "@/components/ui";

/**
 * The access code form of a showcaller portal (B3, ADR 0142), as P1's live-code-form.tsx. Every open needs the
 * code; it travels only in the form body, POSTed to the portal's open handler, which sets the device grant and
 * comes back. A refusal shows above the form.
 */
export async function ShowcallerCodeForm({
  path,
  reason,
}: {
  /** The portal, /share/showcaller/{token}; the form posts to its /open. */
  path: string;
  reason: ShowcallerRefusal | null;
}) {
  const t = await getTranslations("compliance.showcallerPortal");
  const asks = reason === null || showcallerAsksForCode(reason);
  return (
    <div className="mx-auto flex max-w-layout-form flex-col gap-16">
      <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
      {reason && reason !== "showcaller_link_grant" ? (
        <InlineAlert tone={asks ? "warning" : "danger"}>{t(`refusals.${reason}`)}</InlineAlert>
      ) : null}
      {asks || reason === "showcaller_link_rate_limited" ? (
        <form method="post" action={`${path}/open`} className="flex flex-col gap-12">
          <Input
            width="100%"
            id="showcaller-access-code"
            name="accessCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            label={t("accessCode")}
            help={t("accessCodeHelp")}
            autoFocus
          />
          <Button type="submit" variant="primary" className="w-full">
            {t("submit")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
