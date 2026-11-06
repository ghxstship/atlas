"use client";

import * as enums from "@xos/data/enums";
import { Button, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { OutcomeAlert } from "@/components/actions/action-button";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { fileRatingDisputeAction, type RatingFormState } from "@/lib/actions/engagement";
import { enumLabelKey } from "@/lib/enum-key";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The rated person's dispute of a rating (ADR 0156): why, and what is wrong. It sits closed under the rating so the rating
 * stays the first thing read. A platform operator decides; filing does not hide the rating.
 */
export function RatingDisputeForm({ ratingId }: { ratingId: string }) {
  const t = useTranslations() as unknown as Translate;
  const router = useRouter();
  const [state, action, pending] = useActionState<RatingFormState, FormData>(
    fileRatingDisputeAction,
    {},
  );
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state.done, router]);
  return (
    <details className="text-text-13">
      <summary className="cursor-pointer text-accent-text underline">
        {t("gateway.profile.ratings.dispute.open")}
      </summary>
      <form
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="mt-8 flex flex-col gap-8"
        aria-label={t("gateway.profile.ratings.dispute.open")}
      >
        <OutcomeAlert outcome={state.outcome} />
        <p className="m-0 text-text-secondary">{t("gateway.profile.ratings.dispute.help")}</p>
        <input type="hidden" name="ratingId" value={ratingId} />
        <Select
          id={`dispute-ground-${ratingId}`}
          name="ground"
          label={t("gateway.profile.ratings.dispute.ground")}
          defaultValue={enums.ratingDisputeGround[0]}
          options={enums.ratingDisputeGround.map((g) => ({
            value: g,
            label: t(enumLabelKey("ratingDisputeGround", g)),
          }))}
        />
        <Textarea
          id={`dispute-details-${ratingId}`}
          name="details"
          required
          rows={3}
          width="100%"
          label={t("gateway.profile.ratings.dispute.details")}
        />
        <div>
          <Button type="submit" size="sm" variant="secondary" disabled={pending} aria-busy={pending}>
            {t("gateway.profile.ratings.dispute.submit")}
          </Button>
        </div>
      </form>
    </details>
  );
}
