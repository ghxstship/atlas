"use client";

import type { CapabilityDocument } from "@xos/data/places";
import { Input, Select } from "@xos/ui";
import { saveCapabilityDocumentAction } from "@/app/[org]/places/actions";
import { ActionForm, useCopy } from "../kit/form";
import type { VenueOption } from "../spaces/forms";

/**
 * Create and edit a capability document (tech pack, rigging plot): venue, title, where it is stored
 * and its validity window. A frozen document is never offered for editing.
 */
export function DocumentForm({
  org,
  document,
  venues,
  defaultVenueId,
}: {
  org: string;
  document?: CapabilityDocument;
  venues: readonly VenueOption[];
  defaultVenueId?: string;
}) {
  const t = useCopy("places");
  return (
    <ActionForm
      action={saveCapabilityDocumentAction}
      org={org}
      hidden={document ? { id: document.id, venueId: document.venueId } : {}}
      submitLabel={document ? t("kit.save") : t("documents.create")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (document ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <>
          {document ? null : (
            <Select
              id="document-venue"
              name="venueId"
              label={t("documents.fields.venue")}
              value={defaultVenueId ?? venues[0]?.id ?? ""}
              options={venues.map((v) => ({ value: v.id, label: v.name }))}
              error={error("venueId")}
            />
          )}
          <Input
            id="document-title"
            name="title"
            required
            width="100%"
            label={t("documents.fields.title")}
            defaultValue={document?.title ?? ""}
            error={error("title")}
          />
          <Input
            id="document-uri"
            name="documentUri"
            required
            width="100%"
            label={t("documents.fields.uri")}
            help={t("documents.fields.uriHelp")}
            defaultValue={document?.documentUri ?? ""}
            error={error("documentUri")}
          />
          <div className="flex flex-wrap gap-12">
            <Input
              id="document-from"
              name="validFrom"
              type="date"
              required
              label={t("documents.fields.validFrom")}
              defaultValue={document?.validFrom ?? ""}
              error={error("validFrom")}
            />
            <Input
              id="document-to"
              name="validTo"
              type="date"
              label={t("documents.fields.validTo")}
              help={t("documents.fields.validToHelp")}
              defaultValue={document?.validTo ?? ""}
              error={error("validTo")}
            />
          </div>
        </>
      )}
    </ActionForm>
  );
}
