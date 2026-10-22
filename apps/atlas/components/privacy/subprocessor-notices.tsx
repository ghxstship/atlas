import { getTranslations } from "next-intl/server";
import { SubprocessorSubscribeForm } from "@/components/privacy/subprocessor-subscribe-form";
import { Button, InlineAlert } from "@/components/ui";
import {
  confirmSubprocessorAction,
  unsubscribeSubprocessorAction,
} from "@/lib/privacy/subprocessor-actions";

/** Outcomes the actions report back on the page (no token in the URL). */
const NOTICES = {
  subscribed: "success",
  invalid: "danger",
  failed: "danger",
  confirmed: "success",
  "confirm-failed": "danger",
  unsubscribed: "success",
  "unsubscribe-failed": "danger",
} as const;
type Notice = keyof typeof NOTICES;

function isNotice(value: string | undefined): value is Notice {
  return value !== undefined && Object.hasOwn(NOTICES, value);
}

/**
 * Change notices on the Subprocessor List page (Section 14.4, legal/subprocessors.md section 1;
 * migration 1382): the subscription form, and the confirmation or unsubscribe button an emailed link
 * opens. Public, plain forms. The page renders the token only into a hidden field; the database sees
 * it only when the button is pressed.
 */
export async function SubprocessorNotices({
  confirm,
  unsubscribe,
  notice,
}: {
  confirm?: string | undefined;
  unsubscribe?: string | undefined;
  notice?: string | undefined;
}) {
  const t = await getTranslations("compliance.subprocessors");
  if (confirm || unsubscribe) {
    const isConfirm = Boolean(confirm);
    return (
      <section
        id="notices"
        aria-labelledby="notices-heading"
        className="mx-auto flex w-full max-w-layout-reading flex-col gap-12 px-24 pb-24"
      >
        <h2 id="notices-heading" className="m-0 text-heading-20 font-semibold">
          {t(isConfirm ? "confirmTitle" : "unsubscribeTitle")}
        </h2>
        <p className="m-0 text-text-14 text-text-secondary">
          {t(isConfirm ? "confirmLead" : "unsubscribeLead")}
        </p>
        <form action={isConfirm ? confirmSubprocessorAction : unsubscribeSubprocessorAction}>
          <input type="hidden" name="token" value={confirm ?? unsubscribe ?? ""} />
          <Button type="submit" variant={isConfirm ? "primary" : "secondary"}>
            {t(isConfirm ? "confirm" : "unsubscribe")}
          </Button>
        </form>
      </section>
    );
  }
  return (
    <section
      id="notices"
      aria-labelledby="notices-heading"
      className="mx-auto flex w-full max-w-layout-reading flex-col gap-12 px-24 pb-24"
    >
      <h2 id="notices-heading" className="m-0 text-heading-20 font-semibold">
        {t("title")}
      </h2>
      <p className="m-0 text-text-14 text-text-secondary">{t("lead")}</p>
      {isNotice(notice) ? (
        <InlineAlert tone={NOTICES[notice]}>{t(`notices.${notice}`)}</InlineAlert>
      ) : null}
      <SubprocessorSubscribeForm
        labels={{ email: t("email"), emailHelp: t("emailHelp"), subscribe: t("subscribe") }}
        notices={{
          subscribed: t("notices.subscribed"),
          invalid: t("notices.invalid"),
          failed: t("notices.failed"),
        }}
      />
      <p className="m-0 text-text-13 text-text-secondary">{t("members")}</p>
    </section>
  );
}
