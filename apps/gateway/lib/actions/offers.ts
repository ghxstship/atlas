"use server";

import { acceptOffer, APP_ENUMS, counterOffer, declineOffer } from "@xos/data/gateway";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { parseMoneyInput } from "@/lib/format";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Offer actions (Section 4.4.4 stage 5, A28b 0764): the party accepts, declines or counters the
 * offer in force. Counters carry new terms; the org answers with a new version.
 */

export async function acceptOfferAction(offerId: string): Promise<ActionResult> {
  return toAction(await acceptOffer(await createServerSupabase(), z.uuid().parse(offerId)));
}

export async function declineOfferAction(offerId: string): Promise<ActionResult> {
  return toAction(
    await declineOffer(await createServerSupabase(), {
      offerId: z.uuid().parse(offerId),
      reason: "Declined from Gateway.",
    }),
  );
}

export interface CounterState {
  readonly outcome?: string;
  readonly fieldError?: string;
  readonly done?: boolean;
}

export async function counterOfferAction(_: CounterState, form: FormData): Promise<CounterState> {
  const parsed = z
    .object({
      offerId: z.uuid(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      rateType: z.enum(APP_ENUMS.rate_type),
      startsOn: z.iso.date(),
      endsOn: z.iso.date(),
      amount: z.string(),
      message: z.string().trim().min(1).max(2000),
    })
    .safeParse({
      offerId: form.get("offerId"),
      currency: form.get("currency"),
      rateType: form.get("rateType"),
      startsOn: form.get("startsOn"),
      endsOn: form.get("endsOn"),
      amount: form.get("amount"),
      message: form.get("message"),
    });
  if (!parsed.success) return { fieldError: "counter" };
  const amountMinor = parseMoneyInput(parsed.data.amount, parsed.data.currency);
  if (amountMinor === null) return { fieldError: "amount" };
  if (parsed.data.endsOn < parsed.data.startsOn) return { fieldError: "dates" };
  const result = await counterOffer(await createServerSupabase(), {
    offerId: parsed.data.offerId,
    amountMinor,
    currency: parsed.data.currency,
    rateType: parsed.data.rateType,
    startsOn: parsed.data.startsOn,
    endsOn: parsed.data.endsOn,
    message: parsed.data.message,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
