"use client";

import { NO_LOCATION_DEFAULTS, venueStartValues, type LocationDefaults } from "@xos/data/org-setup";
import type { Jurisdiction, Venue } from "@xos/data/places";
import { Input, Select } from "@xos/ui";
import { useMemo } from "react";
import { saveVenueAction } from "@/app/[org]/places/actions";
import { AddressInputs } from "@/components/address/address-inputs";
import type { AddressFormat } from "@/lib/address";
import { ActionForm, useCopy } from "../kit/form";

/** IANA zones the runtime knows, with the venue's own zone first when it is missing from the list. */
function timeZones(current: string | undefined): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

/**
 * Create and edit a venue: name, canon jurisdiction, IANA time zone, address and an optional
 * location. A blank location stays NULL; the map never guesses one. A new venue starts in the
 * org's location defaults (Settings, Locations and Venues Defaults, migration 1431). The address
 * follows the format of the jurisdiction's country (`addressFormat`, computed on the server); the
 * action checks it against the jurisdiction chosen when it is saved.
 */
export function VenueForm({
  org,
  venue,
  jurisdictions,
  defaults = NO_LOCATION_DEFAULTS,
  addressFormat,
}: {
  org: string;
  venue?: Venue;
  jurisdictions: readonly Jurisdiction[];
  defaults?: LocationDefaults;
  addressFormat: AddressFormat;
}) {
  const t = useCopy("places");
  const start = venueStartValues(
    defaults,
    jurisdictions[0]?.id ?? null,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const zones = useMemo(
    () => timeZones(venue?.timeZone ?? start.timeZone),
    [venue?.timeZone, start.timeZone],
  );
  const defaultZone = venue?.timeZone ?? start.timeZone;
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
            value={venue?.jurisdictionId ?? start.jurisdictionId}
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
          <AddressInputs
            idPrefix="venue"
            format={addressFormat}
            values={
              venue
                ? {
                    streetAddress: venue.streetAddress,
                    locality: venue.locality,
                    administrativeArea: null,
                    postalCode: venue.postalCode,
                  }
                : null
            }
            labels={{
              streetAddress: t("venues.fields.streetAddress"),
              locality: t("venues.fields.locality"),
              administrativeArea: t("venues.fields.administrativeArea"),
              postalCode: t("venues.fields.postalCode"),
            }}
            error={error}
          />
          <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
            <legend className="mb-4 text-label-13 font-medium">
              {t("venues.fields.location")}
            </legend>
            <p className="m-0 text-text-12 text-text-secondary">
              {t("venues.fields.locationHelp")}
            </p>
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
