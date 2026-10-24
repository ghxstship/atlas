/**
 * Adding a pass to the person's wallet (A65-011 part 4): asks the wallet-pass Edge Function for the signed
 * pass with the person's own session, then hands an Apple pass to PassKit's add-pass sheet or opens the
 * Google Wallet link. Returns the message key to show when it could not, or null.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { CompassWallet } from "../../modules/compass-wallet";
import {
  toBase64,
  walletOutcome,
  walletRequest,
  type WalletKind,
  type WalletLabels,
  type WalletPlatform,
} from "../domain/wallet";

/** The wallet this device adds to: Apple Wallet on an iPhone that can, Google Wallet on Android. */
export function deviceWallet(): WalletPlatform | null {
  if (Platform.OS === "android") return "google";
  if (Platform.OS === "ios" && CompassWallet?.canAddPasses()) return "apple";
  return null;
}

export async function addToWallet(
  client: SupabaseClient,
  supabaseUrl: string,
  kind: WalletKind,
  id: string,
  locale: string,
  labels: WalletLabels,
): Promise<string | null> {
  const platform = deviceWallet();
  if (!platform) return "compass.wallet.failed";
  const token = (await client.auth.getSession()).data.session?.access_token;
  if (!token) return "compass.wallet.failed";
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/functions/v1/wallet-pass`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(walletRequest(kind, id, platform, locale, labels)),
    });
  } catch {
    return "compass.wallet.offline";
  }
  const outcome = walletOutcome(
    response.status,
    response.headers.get("content-type"),
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    if (outcome.kind === "pass" && CompassWallet) {
      await CompassWallet.addPass(toBase64(outcome.bytes));
      return null;
    }
    if (outcome.kind === "link") {
      await Linking.openURL(outcome.url);
      return null;
    }
  } catch {
    return "compass.wallet.failed";
  }
  return outcome.kind === "refused" ? outcome.messageKey : "compass.wallet.failed";
}
