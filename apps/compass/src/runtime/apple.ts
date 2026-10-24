/**
 * expo-apple-authentication behind domain/appleSignIn's AppleNative (owner decision 20), expo-crypto behind its
 * NonceSource, and the person's own client behind SaveAppleName. The Apple module is loaded only when it is used,
 * so Android and a build without Apple never touch it.
 */
import type { XosClient } from "@xos/data/client";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import {
  readAppleSignIn,
  type AppleNative,
  type AppleNativeFailure,
  type NonceSource,
  type SaveAppleName,
} from "../domain/appleSignIn";

/** Whether this build turned Sign in with Apple on. Expo inlines each EXPO_PUBLIC_ value at build time. */
export function appleConfigured(): boolean {
  return readAppleSignIn({ EXPO_PUBLIC_APPLE_SIGN_IN: process.env["EXPO_PUBLIC_APPLE_SIGN_IN"] });
}

/** Whether this device offers Sign in with Apple: an iOS build with Apple on, on iOS 13 or later. */
export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios" || !appleConfigured()) return false;
  try {
    const { isAvailableAsync } = await import("expo-apple-authentication");
    return await isAvailableAsync();
  } catch (error) {
    console.warn("Sign in with Apple availability check failed", error);
    return false;
  }
}

export async function loadAppleNative(): Promise<AppleNative> {
  const { signInAsync, AppleAuthenticationScope } = await import("expo-apple-authentication");
  return {
    signIn: async ({ hashedNonce }) => {
      const credential = await signInAsync({
        requestedScopes: [AppleAuthenticationScope.FULL_NAME, AppleAuthenticationScope.EMAIL],
        nonce: hashedNonce,
      });
      return {
        identityToken: credential.identityToken,
        givenName: credential.fullName?.givenName ?? null,
        familyName: credential.fullName?.familyName ?? null,
      };
    },
    failure: (error): AppleNativeFailure => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code === "ERR_REQUEST_CANCELED") return "cancelled";
      if (code === "ERR_REQUEST_NOT_HANDLED" || code === "ERR_INVALID_OPERATION")
        return "unavailable";
      return "other";
    },
  };
}

/** 32 random bytes as hex, and SHA-256 as lowercase hex (expo-crypto's default encoding). */
export const nonceSource: NonceSource = {
  random: () =>
    Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join(""),
  sha256: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
};

/**
 * Keeps the name Apple sends on a first sign-in, which the identity token never carries: in the auth metadata, and
 * on the person row only while it has no name, so a sign-in that links an existing account never renames it
 * (ADR 0036, decision 5). The person may update their own name columns (row level security keeps it to their row).
 */
export function appleNameSaver(client: XosClient): SaveAppleName {
  return async (name) => {
    const { error: metadataError } = await client.auth.updateUser({
      data: { full_name: name.fullName, given_name: name.givenName, family_name: name.familyName },
    });
    if (metadataError) throw metadataError;
    const { data } = await client.auth.getUser();
    const userId = data.user?.id;
    if (!userId) return;
    const { error } = await client
      .from("people")
      .update({
        full_name: name.fullName,
        given_name: name.givenName,
        family_name: name.familyName,
      })
      .eq("user_id", userId)
      .is("full_name", null);
    if (error) throw error;
  };
}
