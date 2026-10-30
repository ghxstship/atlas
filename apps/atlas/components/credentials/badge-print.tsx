import { credentialStatus, type IssuedCredential } from "@xos/data/credentials";
import { credentialPhotoStates, type CredentialPhotoState } from "@xos/data/credential-photos";
import { printSizesFor } from "@xos/data/documents/model";
import { MAX_BATCH } from "@xos/data/documents/render";
import { sectionHref } from "@/components/operations/chrome";
import { SelectField } from "@/components/operations/fields";
import { param, RecordSection, ToneChip } from "@/components/operations/kit";
import { Button, ButtonLink, InlineAlert } from "@/components/ui";
import { requestMissingPhotosAction } from "@/lib/credentials/actions";
import { outcomeSummary, parseAsked } from "@/lib/credentials/photo-outcomes";
import { can, type ModulePage } from "@/lib/operations/context";

export const PHOTO_TONE: Record<
  CredentialPhotoState,
  "success" | "accent" | "neutral" | "warning" | "danger"
> = {
  Provided: "success",
  Scanning: "accent",
  Refused: "danger",
  Profile: "neutral",
  Requested: "warning",
  Missing: "warning",
};

/**
 * The print panel of Issued credentials (P5, `?print=1`): the filtered credentials that are neither revoked nor
 * expired, checked by default with each badge's photo state, in a plain GET form to the badges route, so the
 * download needs no client code. Unchecking a row leaves it out of the PDF. An issuer can ask the holders of the
 * checked badges whose photo is Missing or Requested; the panel then says how each request went.
 */
export async function BadgePrint({
  page,
  credentials,
  section,
}: {
  page: ModulePage;
  credentials: readonly IssuedCredential[];
  section: string;
}) {
  const t = page.t;
  const now = new Date();
  const printable = credentials.filter((c) => {
    const status = credentialStatus(c, now);
    return status !== "revoked" && status !== "expired";
  });
  const listed = printable.slice(0, MAX_BATCH);
  const states = await credentialPhotoStates(
    page.ctx.viewer.db,
    listed.map((c) => c.id),
  );
  const stateOf = (c: IssuedCredential): CredentialPhotoState =>
    (states.ok ? states.data.get(c.id) : undefined) ?? "Missing";
  const asked = param(page.search, "asked");
  const closeHref = sectionHref(page, { print: undefined, asked: undefined, section });
  const back = sectionHref(page, { asked: undefined, section });
  const canIssue = can(page, "credentials.credential.issue");
  return (
    <RecordSection
      id="badge-print"
      title={t("credentials.print.heading")}
      actions={
        <ButtonLink href={closeHref} variant="ghost" size="sm">
          {t("credentials.print.close")}
        </ButtonLink>
      }
    >
      {asked ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("credentials.print.done", { summary: outcomeSummary(t, parseAsked(asked)) })}
        </p>
      ) : null}
      {listed.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("credentials.print.none")}</p>
      ) : (
        <form
          action={`/${page.ctx.org.slug}/documents/badges`}
          method="get"
          className="flex flex-col gap-12"
        >
          <input type="hidden" name="org" value={page.ctx.org.slug} />
          <input type="hidden" name="back" value={back} />
          <p className="m-0 text-text-13 text-text-secondary">{t("credentials.print.lead")}</p>
          {printable.length > listed.length ? (
            <InlineAlert tone="info">
              {t("credentials.print.limit", { count: MAX_BATCH })}
            </InlineAlert>
          ) : null}
          <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-4 text-text-12 font-medium text-text-secondary">
              {t("credentials.print.select")}
            </legend>
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {listed.map((c) => {
                const state = stateOf(c);
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-8 text-text-13">
                    <label className="flex min-w-0 flex-1 items-center gap-8">
                      <input
                        type="checkbox"
                        name="id"
                        value={c.id}
                        defaultChecked
                        className="size-16 shrink-0"
                      />
                      <span className="font-mono">{c.number}</span>
                      <span className="truncate">
                        {c.holderName ?? t("credentials.common.unnamed")}
                      </span>
                    </label>
                    <span className="sr-only">{t("credentials.photo.stateLabel")}</span>
                    <ToneChip tone={PHOTO_TONE[state]}>
                      {t(`credentials.photo.states.${state}`)}
                    </ToneChip>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <div className="flex flex-wrap items-end gap-8">
            <SelectField
              id="badge-print-size"
              name="paper"
              label={t("credentials.print.size")}
              defaultValue="cr80"
              options={printSizesFor("credential-badge").map((size) => ({
                value: size,
                label: t(`documents.paper.${size}`),
              }))}
            />
            <Button type="submit" variant="secondary">
              {t("credentials.print.download")}
            </Button>
            {canIssue ? (
              <Button
                type="submit"
                variant="ghost"
                formAction={requestMissingPhotosAction}
                aria-describedby="badge-print-request-help"
              >
                {t("credentials.print.requestMissing")}
              </Button>
            ) : null}
          </div>
          {canIssue ? (
            <p id="badge-print-request-help" className="m-0 text-text-12 text-text-secondary">
              {t("credentials.print.requestHelp")}
            </p>
          ) : null}
        </form>
      )}
    </RecordSection>
  );
}
