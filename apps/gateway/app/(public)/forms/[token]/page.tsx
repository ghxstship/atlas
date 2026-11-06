import {
  FORM_LINK_TOKEN,
  formLinkAsksForCode,
  parseFormLinkRefusal,
  readPublicForm,
  type FormLinkRefusal,
} from "@xos/data/form-links";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { OutsideCodeForm } from "@/components/outside/code-form";
import { PublicFormFill } from "@/components/outside/public-form";
import { InlineAlert } from "@/components/ui";
import { observability } from "@/lib/observability";
import { FORM_GRANT_COOKIE, publicDb, visitorAddress } from "@/lib/outside/public";
import { getTranslate } from "@/lib/shell/translate";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return {
    title: t("gateway.publicForm.title"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A public form link (B2, ADR 0141): the access code, then a form in windows, then a thank-you. No account is offered.
 * The read answers only key, label, kind, required, choices and show_if: never points, the record kind or the approver.
 */
export default async function PublicFormPage({ params, searchParams }: PageProps<"/forms/[token]">) {
  const { token } = await params;
  if (!FORM_LINK_TOKEN.test(token)) notFound();
  const query = await searchParams;
  const asked: FormLinkRefusal | null =
    typeof query["reason"] === "string" ? parseFormLinkRefusal(query["reason"]) : null;
  const t = await getTranslate();
  const grant = (await cookies()).get(FORM_GRANT_COOKIE)?.value ?? null;
  const path = `/forms/${token}`;
  const heading = <h1 className="m-0 text-heading-24 font-semibold">{t("gateway.publicForm.title")}</h1>;
  const codeForm = (reason: FormLinkRefusal | null) => (
    <OutsideCodeForm
      action={`${path}/open`}
      intro={t("gateway.publicForm.codeIntro")}
      refusal={reason && reason !== "form_link_grant" ? t(`gateway.tokens.refusals.${reason}`) : null}
      stop={reason === "form_link_locked" || reason === "form_link_expired"}
    />
  );
  if (grant === null || (asked !== null && formLinkAsksForCode(asked))) {
    return (
      <>
        {heading}
        {codeForm(asked)}
      </>
    );
  }
  const read = await readPublicForm(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("public form read failed", { route: "/forms/[token]", error: read.error });
    throw new Error("public form read failed");
  }
  if (read.data.refused) {
    return (
      <>
        {heading}
        {formLinkAsksForCode(read.data.reason) ? (
          codeForm(read.data.reason)
        ) : (
          <InlineAlert tone="danger">{t(`gateway.tokens.refusals.${read.data.reason}`)}</InlineAlert>
        )}
      </>
    );
  }
  const form = read.data;
  return (
    <>
      <header
        className="flex flex-col gap-4 border-t-4 pt-12"
        style={form.brandAccentHex ? { borderColor: form.brandAccentHex } : undefined}
      >
        <p className="m-0 text-text-13 text-text-secondary">{form.brandName}</p>
        <h1 className="m-0 text-heading-24 font-semibold">{form.name}</h1>
        {form.description ? <p className="m-0 text-text-14">{form.description}</p> : null}
      </header>
      <PublicFormFill token={token} fields={form.fields} />
      {form.suppressPoweredBy ? null : (
        <footer className="text-text-12 text-text-secondary">{t("gateway.publicForm.poweredBy")}</footer>
      )}
    </>
  );
}
