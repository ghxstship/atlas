import type { LiveLinkRefusal } from "@xos/data/live-links";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert, Input } from "@/components/ui";

/**
 * The access code form of a live link page (P1, ADR 0130). Every open needs the code (Section 7.5
 * invariant 8); it travels only in the form body, POSTed to the link's open handler, which sets the
 * device grant and comes back. A refusal shows above the form.
 */
export async function LiveCodeForm({
  action,
  intro,
  reason,
  tone = "light",
}: {
  action: string;
  intro: string;
  reason: LiveLinkRefusal | null;
  tone?: "light" | "dark";
}) {
  const t = await getTranslations("compliance.liveLinks");
  const asks =
    reason === null ||
    reason === "live_link_grant" ||
    reason === "live_link_access_code_required" ||
    reason === "live_link_access_code";
  return (
    <div
      className={
        tone === "dark"
          ? "mx-auto flex max-w-[28rem] flex-col gap-16 rounded-lg bg-bg-surface p-24 text-text-primary"
          : "mx-auto flex max-w-[28rem] flex-col gap-16"
      }
    >
      <p className="m-0 text-text-14 text-text-secondary">{intro}</p>
      {reason && reason !== "live_link_grant" ? (
        <InlineAlert tone={asks ? "warning" : "danger"}>{t(`refusals.${reason}`)}</InlineAlert>
      ) : null}
      {asks || reason === "live_link_rate_limited" ? (
        <form method="post" action={action} className="flex flex-col gap-12">
          <Input
            width="100%"
            id="live-access-code"
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
