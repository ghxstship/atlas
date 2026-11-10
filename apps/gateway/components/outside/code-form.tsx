import { getTranslations } from "next-intl/server";
import { Button, InlineAlert, Input } from "@/components/ui";
import { GrantRefresh } from "./grant-refresh";

/**
 * The access code form of an intake or public form link (B2, ADR 0141). It posts natively to the link's open handler, a
 * URL action, so a click before hydration still works. The code travels only in the form body.
 */
export async function OutsideCodeForm({
  action,
  intro,
  refusal,
  stop,
}: {
  action: string;
  intro: string;
  refusal: string | null;
  stop: boolean;
}) {
  const t = await getTranslations("gateway.tokens");
  return (
    <div className="flex max-w-layout-form flex-col gap-16">
      {refusal ? null : <GrantRefresh />}
      <p className="m-0 text-text-14 text-text-secondary">{intro}</p>
      {refusal ? <InlineAlert tone={stop ? "danger" : "warning"}>{refusal}</InlineAlert> : null}
      {stop ? null : (
        <form method="post" action={`${action}`} className="flex flex-col gap-12">
          <Input
            width="100%"
            id="outside-access-code"
            name="accessCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            label={t("code")}
            help={t("codeHelp")}
            autoFocus
          />
          <Button type="submit" variant="primary">
            {t("open")}
          </Button>
        </form>
      )}
    </div>
  );
}
