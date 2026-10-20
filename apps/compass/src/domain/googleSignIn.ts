/**
 * Sign in with Google on Compass (ADR 0036). The phone signs in natively with Google's SDK
 * (@react-native-google-signin/google-signin), which returns a Google ID token, and hands that token
 * to Supabase Auth with signInWithIdToken. It is the same account as on Atlas and Gateway: a matching
 * verified email links to the existing person. The native SDK sits behind GoogleNative, so this file
 * stays testable without a device.
 *
 * The client IDs are public build-time values (EXPO_PUBLIC_*), not secrets. The Web client ID is the
 * audience of the ID token on both platforms; iOS also needs its own client ID. Android needs no ID
 * here: Google matches the app by package name and signing certificate.
 */

export interface GoogleClientIds {
  /** The Google Cloud Web client ID: the ID token's audience, also set in Supabase Auth. */
  readonly web: string;
  /** The iOS client ID, or null when the build has none. */
  readonly ios: string | null;
}

/** A Google OAuth client ID: digits, a hyphen, a lowercase key, then Google's domain. */
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function clientId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return CLIENT_ID.test(trimmed) ? trimmed : null;
}

/** The client IDs from the build's public environment, or null when Google sign-in is not set up. */
export function readGoogleClientIds(
  env: Readonly<Record<string, string | undefined>>,
): GoogleClientIds | null {
  const web = clientId(env["EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID"]);
  if (!web) return null;
  return { web, ios: clientId(env["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"]) };
}

/** Whether this build can offer the Google button on this platform. */
export function googleSignInAvailable(ids: GoogleClientIds | null, platform: string): boolean {
  if (!ids) return false;
  if (platform === "ios") return ids.ios !== null;
  return platform === "android";
}

/** How the native SDK reported a failure, in the terms Compass shows. */
export type GoogleNativeFailure = "cancelled" | "in-progress" | "play-services" | "other";

/** The native SDK, reduced to what the sign-in needs. runtime/google.ts implements it. */
export interface GoogleNative {
  configure(options: { readonly webClientId: string; readonly iosClientId?: string }): void;
  /** Android: Google Play services are present and current. iOS always answers true. */
  hasPlayServices(): Promise<boolean>;
  /** Shows Google's account picker; null when the person closed it. */
  signIn(): Promise<{ readonly idToken: string | null } | null>;
  /** Classifies an error the SDK threw. */
  failure(error: unknown): GoogleNativeFailure;
}

/** Supabase Auth's ID token sign-in, as @supabase/supabase-js exposes it. */
export interface IdTokenAuth {
  signInWithIdToken(credentials: { readonly provider: "google"; readonly token: string }): Promise<{
    readonly error: {
      readonly code?: string | undefined;
      readonly status?: number | undefined;
      readonly message: string;
    } | null;
  }>;
}

/** Catalog keys under compass.signIn for what the person sees. */
export type GoogleMessage =
  | "googleCancelled"
  | "googleUnavailable"
  | "googleFailed"
  | "emailNotVerified"
  | "ssoRequired"
  | "network";

export type GoogleSignInOutcome =
  | { readonly kind: "signed-in" }
  /** The person closed Google's picker, or a sign-in was already showing: nothing to report. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly message: GoogleMessage };

/** The message for a Supabase Auth refusal of the ID token. */
export function idTokenRefusal(error: {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message: string;
}): GoogleMessage {
  if (error.code === "provider_email_needs_verification") return "emailNotVerified";
  if (error.code === "sso_required" || error.code === "sso_session_required") return "ssoRequired";
  if (error.status === 0 || /fetch|network/i.test(error.message)) return "network";
  return "googleFailed";
}

/**
 * Runs the native Google sign-in and exchanges its ID token for a Supabase session. The provider
 * holding the session (CompassProvider's onAuthStateChange) takes it from there, as after an email
 * link. The ID token is never stored or logged here.
 */
export async function signInWithGoogle(
  native: GoogleNative,
  auth: IdTokenAuth,
  ids: GoogleClientIds,
): Promise<GoogleSignInOutcome> {
  let idToken: string | null;
  try {
    native.configure({ webClientId: ids.web, ...(ids.ios ? { iosClientId: ids.ios } : {}) });
    if (!(await native.hasPlayServices())) return { kind: "refused", message: "googleUnavailable" };
    const picked = await native.signIn();
    if (!picked) return { kind: "cancelled" };
    idToken = picked.idToken;
  } catch (error) {
    const failure = native.failure(error);
    if (failure === "cancelled" || failure === "in-progress") return { kind: "cancelled" };
    return {
      kind: "refused",
      message: failure === "play-services" ? "googleUnavailable" : "googleFailed",
    };
  }
  if (!idToken) return { kind: "refused", message: "googleFailed" };
  const { error } = await auth.signInWithIdToken({ provider: "google", token: idToken });
  return error ? { kind: "refused", message: idTokenRefusal(error) } : { kind: "signed-in" };
}
