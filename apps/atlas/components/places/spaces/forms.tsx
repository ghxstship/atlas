"use client";

import type { Space, UridCategory, VenueLevel, Zone } from "@xos/data/places";
import { Input, Select } from "@xos/ui";
import { useState } from "react";
import { saveSpaceAction, saveZoneAction } from "@/app/[org]/places/actions";
import { CustomFieldInputs } from "@/components/custom-fields/inputs";
import { ActionForm, useCopy } from "../kit/form";
import { UridPicker } from "../kit/urid-picker";

export interface VenueOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Create and edit a space: venue, name, URID category, level (B1), floor area and capacity (NULL when unknown), and on
 * create the org's custom fields for spaces (A117).
 */
export function SpaceForm({
  org,
  space,
  venues,
  defaultVenueId,
  categories,
  levels = [],
}: {
  org: string;
  space?: Space;
  venues: readonly VenueOption[];
  defaultVenueId?: string;
  categories: readonly UridCategory[];
  levels?: readonly VenueLevel[];
}) {
  const t = useCopy("places");
  const [venueId, setVenueId] = useState(space?.venueId ?? defaultVenueId ?? venues[0]?.id ?? "");
  return (
    <ActionForm
      action={saveSpaceAction}
      org={org}
      hidden={space ? { id: space.id, venueId: space.venueId } : {}}
      submitLabel={space ? t("kit.save") : t("spaces.createSpace")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (space ? null : { create: undefined, peek: `space-${state.id}` })}
    >
      {(error) => (
        <>
          {space ? null : (
            <Select
              id="space-venue"
              name="venueId"
              label={t("spaces.fields.venue")}
              value={venueId}
              onChange={(e) => setVenueId(e.currentTarget.value)}
              options={venues.map((v) => ({ value: v.id, label: v.name }))}
              error={error("venueId")}
            />
          )}
          <Select
            id="space-level"
            name="venueLevelId"
            label={t("plans.levels.level")}
            value={space?.venueLevelId ?? ""}
            options={[
              { value: "", label: t("plans.levels.noLevel") },
              ...levels
                .filter((l) => l.venueId === venueId)
                .map((l) => ({ value: l.id, label: l.name })),
            ]}
            error={error("venueLevelId")}
          />
          <Input
            id="space-name"
            name="name"
            required
            width="100%"
            label={t("spaces.fields.name")}
            defaultValue={space?.name ?? ""}
            error={error("name")}
          />
          <UridPicker
            id="space-urid"
            name="urid"
            label={t("spaces.fields.urid")}
            help={t("spaces.fields.uridHelp")}
            noMatch={t("spaces.fields.uridNoMatch")}
            value={space?.urid ?? null}
            categories={categories}
          />
          <div className="flex flex-wrap gap-12">
            <Input
              id="space-area"
              name="areaSqFt"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              label={t("spaces.fields.area")}
              help={t("spaces.fields.unknownHelp")}
              defaultValue={space?.areaSqFt ?? ""}
              error={error("areaSqFt")}
            />
            <Input
              id="space-capacity"
              name="capacity"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              label={t("spaces.fields.capacity")}
              help={t("spaces.fields.unknownHelp")}
              defaultValue={space?.capacity ?? ""}
              error={error("capacity")}
            />
          </div>
          {space ? null : <CustomFieldInputs table="app.spaces" />}
        </>
      )}
    </ActionForm>
  );
}

/** Create and edit a zone: venue, code (unique per venue), name and the space it sits in. */
export function ZoneForm({
  org,
  zone,
  venues,
  spaces,
  defaultVenueId,
}: {
  org: string;
  zone?: Zone;
  venues: readonly VenueOption[];
  spaces: readonly Space[];
  defaultVenueId?: string;
}) {
  const t = useCopy("places");
  const [venueId, setVenueId] = useState(zone?.venueId ?? defaultVenueId ?? venues[0]?.id ?? "");
  const venueSpaces = spaces.filter((s) => s.venueId === venueId);
  return (
    <ActionForm
      action={saveZoneAction}
      org={org}
      hidden={zone ? { id: zone.id, venueId: zone.venueId } : {}}
      submitLabel={zone ? t("kit.save") : t("spaces.createZone")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (zone ? null : { create: undefined, peek: `zone-${state.id}` })}
    >
      {(error) => (
        <>
          {zone ? null : (
            <Select
              id="zone-venue"
              name="venueId"
              label={t("spaces.fields.venue")}
              value={venueId}
              options={venues.map((v) => ({ value: v.id, label: v.name }))}
              onChange={(e) => setVenueId(e.target.value)}
              error={error("venueId")}
            />
          )}
          <Input
            id="zone-code"
            name="code"
            required
            label={t("spaces.fields.code")}
            help={t("spaces.fields.codeHelp")}
            defaultValue={zone?.code ?? ""}
            autoCapitalize="characters"
            error={error("code")}
          />
          <Input
            id="zone-name"
            name="name"
            required
            width="100%"
            label={t("spaces.fields.name")}
            defaultValue={zone?.name ?? ""}
            error={error("name")}
          />
          <Select
            key={venueId}
            id="zone-space"
            name="spaceId"
            label={t("spaces.fields.space")}
            help={t("spaces.fields.spaceHelp")}
            value={zone?.spaceId ?? ""}
            options={[
              { value: "", label: t("spaces.fields.noSpace") },
              ...venueSpaces.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </>
      )}
    </ActionForm>
  );
}
