"use client";

import type { Attachment } from "@xos/data/attachments";
import type { Sign, SignStep } from "@xos/data/signage";
import { Tag } from "@xos/ui";
import {
  markSignStepAction,
  setSignArtworkAction,
  uploadSignArtworkAction,
} from "@/app/[org]/places/signage/actions";
import { AttachmentPreview } from "@/components/files/file-preview";
import { ActionForm, useCopy } from "../kit/form";

const STAMP: Readonly<Record<SignStep, keyof Sign>> = {
  Ordered: "orderedAt",
  Printed: "printedAt",
  Placed: "placedAt",
};

/**
 * A sign's production steps (ADR 0140 D6): Mark ordered (hidden, with a note, when a purchase order line orders it),
 * Mark printed and Mark placed, each with Undo. The database stamps the time, and placing needs a location.
 */
export function SignSteps({ org, sign }: { org: string; sign: Sign }) {
  const t = useCopy("places");
  const steps: SignStep[] = ["Ordered", "Printed", "Placed"];
  return (
    <section aria-labelledby={`sign-steps-${sign.id}`} className="flex flex-col gap-8">
      <h3 id={`sign-steps-${sign.id}`} className="m-0 text-text-14 font-semibold">
        {t("signage.stepsTitle")}
      </h3>
      {sign.orderedViaPo ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("signage.orderedByPo")}</p>
      ) : null}
      <div className="flex flex-wrap gap-8">
        {steps
          .filter((step) => !(step === "Ordered" && sign.orderedViaPo))
          .map((step) => {
            const done = sign[STAMP[step]] !== null;
            return (
              <ActionForm
                key={step}
                action={markSignStepAction}
                org={org}
                hidden={{ id: sign.id, step, done: done ? "false" : "true" }}
                submitLabel={
                  done
                    ? t("signage.undo", { step: t(`signage.steps.${step}`) })
                    : t(`signage.steps.${step}`)
                }
                submitVariant={done ? "secondary" : "primary"}
                className="flex flex-col gap-4"
              />
            );
          })}
      </div>
    </section>
  );
}

/** The sign's artwork files: upload one as an attachment on the sign, preview it, and choose which is the artwork. */
export function SignArtwork({
  org,
  sign,
  canWrite,
  files,
}: {
  org: string;
  sign: Sign;
  canWrite: boolean;
  files: readonly {
    readonly attachment: Attachment;
    readonly versionId: string | null;
    readonly isArtwork: boolean;
  }[];
}) {
  const t = useCopy("places");
  return (
    <section aria-labelledby={`sign-art-${sign.id}`} className="flex flex-col gap-8">
      <h3 id={`sign-art-${sign.id}`} className="m-0 text-text-14 font-semibold">
        {t("signage.artwork")}
      </h3>
      {files.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("signage.noArtwork")}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-8 p-0">
        {files.map(({ attachment, versionId, isArtwork }) => (
          <li key={attachment.id} className="flex flex-wrap items-center gap-8 text-text-13">
            <span>{attachment.title}</span>
            {isArtwork ? <Tag tone="success">{t("signage.isArtwork")}</Tag> : null}
            {versionId ? (
              <AttachmentPreview attachment={attachment} />
            ) : (
              <Tag>{t("signage.scanning")}</Tag>
            )}
            {canWrite && versionId && !isArtwork ? (
              <ActionForm
                action={setSignArtworkAction}
                org={org}
                hidden={{ id: sign.id, versionId }}
                submitLabel={t("signage.useAsArtwork")}
                submitVariant="secondary"
              />
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <ActionForm
          action={uploadSignArtworkAction}
          org={org}
          hidden={{ id: sign.id }}
          submitLabel={t("signage.uploadArtwork")}
          submitVariant="secondary"
        >
          {(error) => (
            <label className="flex flex-col gap-4 text-text-13">
              <span>{t("signage.artworkFile")}</span>
              <input
                name="file"
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                required
                className="text-text-13"
              />
              {error("file") ? <span className="text-danger-text">{error("file")}</span> : null}
            </label>
          )}
        </ActionForm>
      ) : null}
    </section>
  );
}
