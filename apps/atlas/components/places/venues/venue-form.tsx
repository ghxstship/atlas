"use client";

import type { Jurisdiction, Venue } from "@xos/data/places";
import { Input, Select } from "@xos/ui";
import { useMemo } from "react";
import { saveVenueAction } from "@/app/[org]/places/actions";
import { ActionForm, useCopy } from "../kit/form";

/** IANA zones the runtime knows, with the venue's own zone first when it is missing from the list. */
function timeZones(current: string | undefined): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

/**
 * Create and edit a venue: name, canon jurisdiction, IANA time zone, address and an optional
 * location. A blank location stays NULL; the map never guesses one.
 */
export function VenueForm({
  org,
  venue,
  jurisdictions,
}: {
  org: string;
  venue?: Venue;
  jurisdictions: readonly Jurisdiction[];
}) {
  const t = useCopy("places");
  const zones = useMemo(() => timeZones(venue?.timeZone), [venue?.timeZone]);
  const defaultZone = venue?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <ActionForm
      action={saveVenueAction}
      org={org}
      hidden={venue ? { id: venue.id } : {}}
      submitLabel={venue ? t("kit.save") : t("venues.create")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (venue ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <>
          <Input
            id="venue-name"
            name="name"
            required
            width="100%"
            label={t("venues.fields.name")}
            defaultValue={venue?.name ?? ""}
            error={error("name")}
          />
          <Select
            id="venue-jurisdiction"
            name="jurisdictionId"
            label={t("venues.fields.jurisdiction")}
            help={t("venues.fields.jurisdictionHelp")}
            value={venue?.jurisdictionId ?? jurisdictions[0]?.id ?? ""}
            options={jurisdictions.map((j) => ({
              value: j.id,
              label: j.populated ? j.id : t("venues.unpopulated", { id: j.id }),
            }))}
            error={error("jurisdictionId")}
          />
          <Select
            id="venue-time-zone"
            name="timeZone"
            label={t("venues.fields.timeZone")}
            value={defaultZone}
            options={zones.map((z) => ({ value: z, label: z }))}
            error={error("timeZone")}
          />
          <Input
            id="venue-street"
            name="streetAddress"
            width="100%"
            autoComplete="street-address"
            label={t("venues.fields.streetAddress")}
            defaultValue={venue?.streetAddress ?? ""}
          />
          <div className="flex flex-wrap gap-12">
            <Input
              id="venue-locality"
              name="locality"
              autoComplete="address-level2"
              label={t("venues.fields.locality")}
              defaultValue={venue?.locality ?? ""}
            />
            <Input
              id="venue-postal"
              name="postalCode"
              autoComplete="postal-code"
              label={t("venues.fields.postalCode")}
              defaultValue={venue?.postalCode ?? ""}
            />
          </div>
          <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
            <legend className="mb-4 text-label-13 font-medium">{t("venues.fields.location")}</legend>
            <p className="m-0 text-text-12 text-text-secondary">{t("venues.fields.locationHelp")}</p>
            <div className="flex flex-wrap gap-12">
              <Input
                id="venue-latitude"
                name="latitude"
                type="number"
                step="any"
                inputMode="decimal"
                label={t("venues.fields.latitude")}
                defaultValue={venue?.latitude ?? ""}
                error={error("latitude")}
              />
              <Input
                id="venue-longitude"
                name="longitude"
                type="number"
                step="any"
                inputMode="decimal"
                label={t("venues.fields.longitude")}
                defaultValue={venue?.longitude ?? ""}
                error={error("longitude")}
              />
            </div>
          </fieldset>
        </>
      )}
    </ActionForm>
  );
}
