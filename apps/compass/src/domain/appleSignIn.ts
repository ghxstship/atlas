/**
 * Sign in with Apple on Compass (ADR 0033 decision 58, App Store Review Guideline 4.8). On iOS the phone signs in with
 * Apple's own sheet (expo-apple-authentication), which returns an identity token, and hands that token to Supabase
 * Auth with signInWithIdToken, as Google does (ADR 0036). It is the same account as on Atlas and Gateway: a matching
 * verified email links to the existing person.
 *
 * The nonce is checked, unlike Google's (ADR 0036, decision 9): Compass makes a random nonce, gives Apple its
 * SHA-256, which Apple signs into the token, and gives Supabase Auth the nonce itself, which Supabase Auth hashes and
 * compares. A captured token is useless without the nonce, which never leaves the device's memory.
 *
 * Which buttons show is decided here (signInButtons): the build turns Apple on explicitly
 * (EXPO_PUBLIC_APPLE_SIGN_IN), and on iOS the Google button waits for Apple (Guideline 4.8 asks for Sign in with
 * Apple beside any third-party sign-in), so an iOS build without Apple configured shows neither. Android and other
 * platforms keep Google as before. The native module sits behind AppleNative, so this file stays testable.
 */
import { googleSignInAvailable, idTokenRefusal, type GoogleClientIds } from "./googleSignIn";

/** Whether the build turned Sign in with Apple on: a public build value, "1" or "true". */
export function readAppleSignIn(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env["EXPO_PUBLIC_APPLE_SIGN_IN"]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export interface SignInButtons {
  readonly apple: boolean;
  readonly google: boolean;
}

/**
 * The provider buttons the sign-in screen shows. iOS: Apple when the build turned it on and the device offers it,
 * and Google only beside Apple. Elsewhere: no Apple, and Google as googleSignInAvailable decides.
 */
export function signInButtons(input: {
  readonly platform: string;
  readonly appleConfigured: boolean;
  /** AppleAuthentication.isAvailableAsync on this device; false until it answers. */
  readonly appleAvailable: boolean;
  readonly googleIds: GoogleClientIds | null;
}): SignInButtons {
  if (input.platform !== "ios") {
    return { apple: false, google: googleSignInAvailable(input.googleIds, input.platform) };
  }
  const apple = input.appleConfigured && input.appleAvailable;
  return { apple, google: apple && googleSignInAvailable(input.googleIds, "ios") };
}

/** How the native module reported a failure, in the terms Compass shows. */
export type AppleNativeFailure = "cancelled" | "unavailable" | "other";

/** Apple's credential, reduced to what the sign-in needs. */
export interface AppleCredential {
  readonly identityToken: string | null;
  /** Apple sends the name on the first authorization only, and never in the token. */
  readonly givenName: string | null;
  readonly familyName: string | null;
}

/** The native module, reduced to what the sign-in needs. runtime/apple.ts implements it. */
export interface AppleNative {
  /** Shows Apple's sheet asking for the name and email, with the nonce's SHA-256. */
  signIn(options: { readonly hashedNonce: string }): Promise<AppleCredential>;
  /** Classifies an error the module threw. */
  failure(error: unknown): AppleNativeFailure;
}

/** Makes the nonce: random bytes as text, and the SHA-256 of a text as lowercase hex. runtime/apple.ts uses expo-crypto. */
export interface NonceSource {
  random(): string;
  sha256(value: string): Promise<string>;
}

/** Supabase Auth's ID token sign-in for Apple, as @supabase/supabase-js exposes it. */
export interface AppleIdTokenAuth {
  signInWithIdToken(credentials: {
    readonly provider: "apple";
    readonly token: string;
    readonly nonce: string;
  }): Promise<{
    readonly error: {
      readonly code?: string | undefined;
      readonly status?: number | undefined;
      readonly message: string;
    } | null;
  }>;
}

/** Keeps the name Apple sent on a first sign-in, for an account that has none. Best effort. */
export type SaveAppleName = (name: {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly fullName: string;
}) => Promise<void>;

/** Catalog keys under compass.signIn for what the person sees. */
export type AppleMessage =
  | "appleCancelled"
  | "appleUnavailable"
  | "appleFailed"
  | "emailNotVerified"
  | "ssoRequired"
  | "network";

export type AppleSignInOutcome =
  | { readonly kind: "signed-in" }
  /** The person closed Apple's sheet: nothing to report beyond a note. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly message: AppleMessage };

/** The message for a Supabase Auth refusal of Apple's token: the same cases as Google's (ADR 0036, decision 4). */
export function appleTokenRefusal(error: {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message: string;
}): AppleMessage {
  const refusal = idTokenRefusal(error);
  return refusal === "emailNotVerified" || refusal === "ssoRequired" || refusal === "network"
    ? refusal
    : "appleFailed";
}

/** The name Apple sent, as one line, or null when it sent none. */
export function appleFullName(credential: AppleCredential): string | null {
  const name = [credential.givenName, credential.familyName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  return name === "" ? null : name;
}

/**
 * Runs the native Apple sign-in with a fresh nonce and exchanges the identity token and the nonce for a Supabase
 * session; the provider holding the session (CompassProvider's onAuthStateChange) takes it from there. The token
 * and the nonce are never stored or logged here.
 */
export async function signInWithApple(
  native: AppleNative,
  auth: AppleIdTokenAuth,
  nonces: NonceSource,
  saveName?: SaveAppleName,
): Promise<AppleSignInOutcome> {
  const nonce = nonces.random();
  let credential: AppleCredential;
  try {
    credential = await native.signIn({ hashedNonce: await nonces.sha256(nonce) });
  } catch (error) {
    const failure = native.failure(error);
    if (failure === "cancelled") return { kind: "cancelled" };
    return {
      kind: "refused",
      message: failure === "unavailable" ? "appleUnavailable" : "appleFailed",
    };
  }
  if (!credential.identityToken) return { kind: "refused", message: "appleFailed" };
  const { error } = await auth.signInWithIdToken({
    provider: "apple",
    token: credential.identityToken,
    nonce,
  });
  if (error) return { kind: "refused", message: appleTokenRefusal(error) };
  const fullName = appleFullName(credential);
  if (fullName !== null && saveName) {
    try {
      await saveName({
        givenName: credential.givenName,
        familyName: credential.familyName,
        fullName,
      });
    } catch (saveError) {
      console.warn("Saving the name from Apple failed", saveError);
    }
  }
  return { kind: "signed-in" };
}
