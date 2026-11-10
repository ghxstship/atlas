"use client";

import type { VenueLevel } from "@xos/data/places";
import { Input } from "@xos/ui";
import { setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { moveVenueLevelAction, saveVenueLevelAction } from "@/app/[org]/places/plan-actions";
import { ActionForm, useCopy } from "../kit/form";

/**
 * The levels of a venue (G-06, ADR 0140): add, rename, reorder and archive. Spaces and site plans name a level of
 * their own venue, and the Plans list orders plans by level. Moving a level up or down renumbers the venue's levels
 * in one call (app.reorder_venue_levels).
 */
export function LevelsSection({
  org,
  venueId,
  levels,
  canWrite,
}: {
  org: string;
  venueId: string;
  levels: readonly VenueLevel[];
  canWrite: boolean;
}) {
  const t = useCopy("places");
  const ids = levels.map((l) => l.id);
  const swapped = (i: number, j: number) => {
    const next = [...ids];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    return next.join(",");
  };
  return (
    <section aria-labelledby={`levels-${venueId}`} className="flex flex-col gap-12">
      <h3 id={`levels-${venueId}`} className="m-0 text-text-16 font-semibold">
        {t("plans.levels.title")}
      </h3>
      {levels.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("plans.levels.none")}</p>
      ) : null}
      <ol className="m-0 flex list-none flex-col gap-12 p-0">
        {levels.map((level, i) => (
          <li key={level.id} className="flex flex-col gap-8 border-b border-border-subtle pb-12">
            {canWrite ? (
              <>
                <ActionForm
                  action={saveVenueLevelAction}
                  org={org}
                  hidden={{ id: level.id, venueId }}
                  submitLabel={t("plans.levels.save")}
                  submitVariant="secondary"
                  successMessage={t("plans.levels.saved")}
                  className="flex flex-wrap items-end gap-12"
                >
                  {(error) => (
                    <>
                      <Input
                        id={`level-name-${level.id}`}
                        name="name"
                        required
                        label={t("plans.levels.level")}
                        defaultValue={level.name}
                        error={error("name")}
                      />
                      <Input
                        id={`level-order-${level.id}`}
                        name="order"
                        type="number"
                        step="1"
                        min="-20"
                        max="200"
                        label={t("plans.levels.order")}
                        defaultValue={String(level.order)}
                        error={error("order")}
                      />
                    </>
                  )}
                </ActionForm>
                <div className="flex flex-wrap gap-8">
                  {i > 0 ? (
                    <ActionForm
                      action={moveVenueLevelAction}
                      org={org}
                      hidden={{ venueId, order: swapped(i, i - 1) }}
                      submitLabel={t("plans.levels.moveUp")}
                      submitVariant="secondary"
                    />
                  ) : null}
                  {i < levels.length - 1 ? (
                    <ActionForm
                      action={moveVenueLevelAction}
                      org={org}
                      hidden={{ venueId, order: swapped(i, i + 1) }}
                      submitLabel={t("plans.levels.moveDown")}
                      submitVariant="secondary"
                    />
                  ) : null}
                  <ActionForm
                    action={setPlaceArchivedAction}
                    org={org}
                    hidden={{ table: "venue_levels", id: level.id, archived: "true" }}
                    submitLabel={t("plans.levels.archive")}
                    submitVariant="secondary"
                  />
                </div>
              </>
            ) : (
              <span className="text-text-14">
                {level.name} · {t("plans.levels.order")}: {level.order}
              </span>
            )}
          </li>
        ))}
      </ol>
      {canWrite ? (
        <ActionForm
          action={saveVenueLevelAction}
          org={org}
          hidden={{ venueId }}
          submitLabel={t("plans.levels.add")}
          successMessage={t("plans.levels.saved")}
          className="flex flex-wrap items-end gap-12"
        >
          {(error) => (
            <>
              <Input
                id={`level-new-${venueId}`}
                name="name"
                required
                label={t("plans.levels.level")}
                error={error("name")}
              />
              <Input
                id={`level-new-order-${venueId}`}
                name="order"
                type="number"
                step="1"
                min="-20"
                max="200"
                label={t("plans.levels.order")}
                help={t("plans.levels.orderHelp")}
                defaultValue={String((levels[levels.length - 1]?.order ?? -1) + 1)}
                error={error("order")}
              />
            </>
          )}
        </ActionForm>
      ) : null}
    </section>
  );
}
