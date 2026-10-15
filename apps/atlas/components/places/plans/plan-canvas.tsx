"use client";

import type { SitePlan, SitePlanPin, Zone } from "@xos/data/places";
import { Input, Select } from "@xos/ui";
import { useState } from "react";
import { addPinAction, movePinAction, saveSitePlanAction } from "@/app/[org]/places/actions";
import { ActionForm, useCopy } from "../kit/form";

/** Only web addresses render as an image; a storage path shows the drawing grid with its pins. */
function isWebImage(uri: string): boolean {
  return /^https?:\/\//.test(uri);
}

const percent = (ratio: number) => Math.round(ratio * 1000) / 10;

/**
 * A site plan drawing with its pins (Section 11.15, site plan view). Pins sit at fractions of the
 * drawing, so they stay put at any width. Clicking the drawing proposes a position for a new pin;
 * the numbered legend and the position fields are the keyboard and screen reader path.
 */
export function PlanCanvas({
  org,
  plan,
  zones,
  canWrite,
}: {
  org: string;
  plan: SitePlan;
  zones: readonly Zone[];
  canWrite: boolean;
}) {
  const t = useCopy("places");
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const zoneName = new Map(zones.map((z) => [z.id, `${z.code} ${z.name}`]));
  return (
    <div className="flex flex-col gap-16">
      <div
        className="relative w-full overflow-hidden rounded-card border border-border-subtle bg-bg-surface"
        style={{ aspectRatio: "16 / 10" }}
      >
        {isWebImage(plan.imageUri) ? (
          // The drawing is user content at an arbitrary address, so next/image's domain list cannot cover it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={plan.imageUri}
            alt={t("plans.drawingAlt", { title: plan.title })}
            className="absolute inset-0 size-full object-contain"
          />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(var(--color-border-subtle)_var(--stroke-width-hairline),transparent_var(--stroke-width-hairline)),linear-gradient(90deg,var(--color-border-subtle)_var(--stroke-width-hairline),transparent_var(--stroke-width-hairline))] bg-[size:5%_8%]"
          />
        )}
        {canWrite ? (
          <button
            type="button"
            aria-label={t("plans.placeHint")}
            className="absolute inset-0 cursor-crosshair bg-transparent"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setDraft({
                x: (e.clientX - box.left) / box.width,
                y: (e.clientY - box.top) / box.height,
              });
            }}
          />
        ) : null}
        {plan.pins.map((pin, i) => (
          <span
            key={pin.id}
            aria-hidden="true"
            className="pointer-events-none absolute flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-text-12 font-semibold text-text-on-accent"
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          >
            {i + 1}
          </span>
        ))}
        {draft ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-bg-canvas"
            style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
          />
        ) : null}
      </div>
      <ol aria-label={t("plans.legend")} className="m-0 flex list-none flex-col gap-8 p-0">
        {plan.pins.length === 0 ? (
          <li className="text-text-13 text-text-secondary">
            {canWrite ? t("plans.noPins") : t("plans.noPinsReadOnly")}
          </li>
        ) : (
          plan.pins.map((pin, i) => (
            <PinRow
              key={pin.id}
              org={org}
              pin={pin}
              n={i + 1}
              zone={pin.zoneId ? zoneName.get(pin.zoneId) : undefined}
              canWrite={canWrite}
            />
          ))
        )}
      </ol>
      {canWrite ? (
        <section aria-labelledby="pin-add-heading" className="flex flex-col gap-8">
          <h3 id="pin-add-heading" className="m-0 text-text-14 font-semibold">
            {t("plans.addPin")}
          </h3>
          <ActionForm
            key={draft ? `${draft.x}-${draft.y}` : "new"}
            action={addPinAction}
            org={org}
            hidden={{ sitePlanId: plan.id }}
            submitLabel={t("plans.addPin")}
            successMessage={t("plans.pinPlaced")}
            onSuccess={() => {
              setDraft(null);
              return null;
            }}
          >
            {(error) => (
              <>
                <Input
                  id="pin-label"
                  name="label"
                  required
                  label={t("plans.fields.label")}
                  error={error("label")}
                />
                <div className="flex flex-wrap gap-12">
                  <Input
                    id="pin-x"
                    name="x"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                    label={t("plans.fields.x")}
                    defaultValue={draft ? percent(draft.x) : ""}
                    error={error("x")}
                  />
                  <Input
                    id="pin-y"
                    name="y"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                    label={t("plans.fields.y")}
                    defaultValue={draft ? percent(draft.y) : ""}
                    error={error("y")}
                  />
                </div>
                <Select
                  id="pin-zone"
                  name="zoneId"
                  label={t("plans.fields.zone")}
                  value=""
                  options={[
                    { value: "", label: t("plans.fields.noZone") },
                    ...zones.map((z) => ({ value: z.id, label: `${z.code} ${z.name}` })),
                  ]}
                />
              </>
            )}
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}

function PinRow({
  org,
  pin,
  n,
  zone,
  canWrite,
}: {
  org: string;
  pin: SitePlanPin;
  n: number;
  zone: string | undefined;
  canWrite: boolean;
}) {
  const t = useCopy("places");
  const [moving, setMoving] = useState(false);
  const pinText = t("plans.pinLine", { n, label: pin.label, x: percent(pin.x), y: percent(pin.y) });
  const line = zone ? `${pinText} · ${zone}` : pinText;
  return (
    <li className="flex flex-col gap-8 border-b border-border-subtle pb-8">
      <div className="flex flex-wrap items-center justify-between gap-8 text-text-13">
        <span>{line}</span>
        {canWrite ? (
          <button
            type="button"
            className="text-accent-text underline"
            onClick={() => setMoving((m) => !m)}
          >
            {moving ? t("kit.cancel") : t("plans.move")}
          </button>
        ) : null}
      </div>
      {moving ? (
        <ActionForm
          action={movePinAction}
          org={org}
          hidden={{ id: pin.id }}
          submitLabel={t("plans.move")}
          className="flex flex-wrap items-end gap-12"
          onSuccess={() => {
            setMoving(false);
            return null;
          }}
        >
          {(error) => (
            <>
              <Input
                id={`move-x-${pin.id}`}
                name="x"
                type="number"
                min="0"
                max="100"
                step="0.1"
                label={t("plans.fields.x")}
                defaultValue={percent(pin.x)}
                error={error("x")}
              />
              <Input
                id={`move-y-${pin.id}`}
                name="y"
                type="number"
                min="0"
                max="100"
                step="0.1"
                label={t("plans.fields.y")}
                defaultValue={percent(pin.y)}
              />
            </>
          )}
        </ActionForm>
      ) : null}
    </li>
  );
}

/** Create and edit a site plan: project (on create), title, drawing location and venue drawn. */
export function SitePlanForm({
  org,
  plan,
  projects,
  venues,
  defaultProjectId,
}: {
  org: string;
  plan?: SitePlan;
  projects: readonly { id: string; label: string }[];
  venues: readonly { id: string; name: string }[];
  defaultProjectId?: string;
}) {
  const t = useCopy("places");
  return (
    <ActionForm
      action={saveSitePlanAction}
      org={org}
      hidden={plan ? { id: plan.id } : {}}
      submitLabel={plan ? t("kit.save") : t("plans.create")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (plan ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <>
          {plan ? null : (
            <Select
              id="plan-project"
              name="projectId"
              label={t("plans.fields.project")}
              value={defaultProjectId ?? projects[0]?.id ?? ""}
              options={projects.map((p) => ({ value: p.id, label: p.label }))}
              error={error("projectId")}
            />
          )}
          <Input
            id="plan-title"
            name="title"
            required
            width="100%"
            label={t("plans.fields.title")}
            defaultValue={plan?.title ?? ""}
            error={error("title")}
          />
          <Input
            id="plan-image"
            name="imageUri"
            required
            width="100%"
            label={t("plans.fields.image")}
            help={t("plans.fields.imageHelp")}
            defaultValue={plan?.imageUri ?? ""}
            error={error("imageUri")}
          />
          <Select
            id="plan-venue"
            name="venueId"
            label={t("plans.fields.venue")}
            value={plan?.venueId ?? ""}
            options={[
              { value: "", label: t("plans.fields.noVenue") },
              ...venues.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </>
      )}
    </ActionForm>
  );
}
