/**
 * expo-apple-authentication behind domain/appleSignIn's AppleNative (ADR 0033 decision 58), expo-crypto behind its
 * NonceSource, the person's own client behind SaveAppleName, and the apple-revoke Edge Function behind its
 * AppleRevokeCall. The availability check and the sign-in load the module's functions when first called. SignIn.tsx
 * imports its button statically, which Android and a build without Apple can load: the package looks its native
 * module up optionally, and the button renders only when appleAvailable() answers true.
 */
import type { XosClient } from "@xos/data/client";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import {
  readAppleSignIn,
  type AppleNative,
  type AppleNativeFailure,
  type AppleRevokeCall,
  type NonceSource,
  type SaveAppleName,
  signedInWithApple,
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
    reauthorize: async () => (await signInAsync({ requestedScopes: [] })).authorizationCode,
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

/**
 * Posts a fresh authorization code and this build's bundle ID to the apple-revoke Edge Function with the person's own
 * session, before their account is deleted. The bundle ID tells the function which app the code was issued to.
 */
export function appleRevoker(client: XosClient, supabaseUrl: string): AppleRevokeCall {
  return async (authorizationCode) => {
    const token = (await client.auth.getSession()).data.session?.access_token;
    const clientId = Constants.expoConfig?.ios?.bundleIdentifier;
    if (!token || !clientId) return { status: 0, reason: null };
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/functions/v1/apple-revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ authorizationCode, clientId }),
      });
    } catch {
      return { status: 0, reason: null };
    }
    const problem = (await response.json().catch(() => null)) as { reason?: unknown } | null;
    return {
      status: response.status,
      reason: typeof problem?.reason === "string" ? problem.reason : null,
    };
  };
}

/**
 * Whether the signed-in account signs in with Apple, from Supabase Auth's answer, or from the session this device holds
 * when Supabase Auth does not answer.
 */
export async function accountSignsInWithApple(client: XosClient): Promise<boolean> {
  const { data, error } = await client.auth.getUser();
  if (!error && data.user) return signedInWithApple(data.user.identities);
  const session = (await client.auth.getSession()).data.session;
  return signedInWithApple(session?.user.identities);
}
