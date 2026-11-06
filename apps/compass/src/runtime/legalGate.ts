/**
 * Asks the server what the signed-in person owes (src/domain/legalGate.ts) and remembers on the device, in the Keychain,
 * only that the server cleared this person and their last AI choice. The device's memory never answers the questions;
 * it only lets a person the server already cleared keep working with no signal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "@xos/data/client";
import { readLegalStanding, type AiChoice } from "@xos/data/consent";
import { listPendingReacceptances, type LegalReacceptance } from "@xos/data/legal-reacceptance";
import * as SecureStore from "expo-secure-store";
import {
  aiChoiceState,
  decideGate,
  legalNeeds,
  type AiChoiceState,
  type GateDecision,
} from "../domain/legalGate";

const clearedKey = (userId: string) => `xos.compass.legal-cleared.${userId}`;
const aiKey = (userId: string) => `xos.compass.ai-choice.${userId}`;

export interface GateReading {
  readonly decision: GateDecision;
  /** Announced changes still in their notice period: a prompt, never a stop. */
  readonly upcoming: readonly LegalReacceptance[];
  readonly aiChoice: AiChoiceState;
}

export async function readGate(
  client: SupabaseClient,
  userId: string,
  cachedIdentity: () => Promise<boolean>,
): Promise<GateReading> {
  const db = client as unknown as XosClient;
  const [standing, announced] = await Promise.all([
    readLegalStanding(db),
    listPendingReacceptances(db, null),
  ]);
  if (standing.ok && announced.ok) {
    const decision = decideGate({
      needs: legalNeeds(standing.data, announced.data),
      clearedBefore: false,
      cachedIdentity: false,
    });
    if (decision.kind === "clear") await SecureStore.setItemAsync(clearedKey(userId), "yes");
    const { aiChoice, aiDisclosureVersion } = standing.data;
    await rememberAiChoice(userId, aiChoice, aiDisclosureVersion);
    return {
      decision,
      upcoming: announced.data.filter((c) => !c.required),
      aiChoice: aiChoiceState(aiChoice, aiDisclosureVersion),
    };
  }
  const clearedBefore = (await SecureStore.getItemAsync(clearedKey(userId))) !== null;
  return {
    decision: decideGate({
      needs: null,
      clearedBefore,
      cachedIdentity: clearedBefore ? true : await cachedIdentity(),
    }),
    upcoming: [],
    aiChoice: await rememberedAiChoice(userId),
  };
}

export async function rememberAiChoice(
  userId: string,
  choice: AiChoice | null,
  version: string | null,
): Promise<void> {
  if (choice === null) await SecureStore.deleteItemAsync(aiKey(userId));
  else await SecureStore.setItemAsync(aiKey(userId), JSON.stringify({ choice, version }));
}

async function rememberedAiChoice(userId: string): Promise<AiChoiceState> {
  const raw = await SecureStore.getItemAsync(aiKey(userId));
  if (!raw) return "unknown";
  try {
    const { choice, version } = JSON.parse(raw) as { choice: AiChoice; version: string | null };
    return aiChoiceState(choice, version);
  } catch {
    return "unknown";
  }
}

/** Forgets what this device remembers about the person: sign-out wipes it with the local store. */
export async function forgetGate(userId: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(clearedKey(userId)),
    SecureStore.deleteItemAsync(aiKey(userId)),
  ]);
}
