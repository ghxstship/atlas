"use server";

import { FEEDBACK_TRIAGE_STATES, triageFeedback, type FeedbackState } from "@xos/data/feedback";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/shell/context";

/** Platform staff: moves feedback to Read, Planned or Closed with a note (1531). The database refuses anyone else. */
export async function triageFeedbackAction(form: FormData): Promise<{ readonly ok: boolean }> {
  const parsed = z
    .object({
      id: z.uuid(),
      state: z.enum(
        FEEDBACK_TRIAGE_STATES as [
          Exclude<FeedbackState, "New">,
          ...Exclude<FeedbackState, "New">[],
        ],
      ),
      note: z.string().trim().max(2000),
    })
    .safeParse({ id: form.get("id"), state: form.get("state"), note: form.get("note") ?? "" });
  if (!parsed.success) return { ok: false };
  const viewer = await getViewer();
  if (!viewer?.person) return { ok: false };
  const result = await triageFeedback(viewer.db, {
    id: parsed.data.id,
    state: parsed.data.state,
    note: parsed.data.note === "" ? null : parsed.data.note,
  });
  if (result.ok) revalidatePath("/support/feedback");
  return { ok: result.ok };
}
