/**
 * The Google Sign-In SDK behind domain/googleSignIn's GoogleNative (ADR 0036). The SDK module is
 * loaded only when it is used, so a screen that does not offer Google never touches the native side.
 * statusCodes carry each platform's own error codes.
 */
import { Platform } from "react-native";
import {
  googleSignInAvailable,
  readGoogleClientIds,
  type GoogleClientIds,
  type GoogleNative,
  type GoogleNativeFailure,
} from "../domain/googleSignIn";

/** The client IDs this build was made with. Expo inlines each EXPO_PUBLIC_ value at build time. */
export function googleClientIds(): GoogleClientIds | null {
  return readGoogleClientIds({
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env["EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID"],
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID"],
  });
}

/** Whether this build offers Continue with Google on this device. */
export function googleOffered(): boolean {
  return googleSignInAvailable(googleClientIds(), Platform.OS);
}

export async function loadGoogleNative(): Promise<GoogleNative> {
  const { GoogleSignin, isErrorWithCode, statusCodes } =
    await import("@react-native-google-signin/google-signin");
  return {
    configure: (options) => GoogleSignin.configure(options),
    hasPlayServices: () => GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true }),
    signIn: async () => {
      const response = await GoogleSignin.signIn();
      return response.type === "success" ? { idToken: response.data.idToken } : null;
    },
    failure: (error): GoogleNativeFailure => {
      if (!isErrorWithCode(error)) return "other";
      if (error.code === statusCodes.SIGN_IN_CANCELLED) return "cancelled";
      if (error.code === statusCodes.IN_PROGRESS) return "in-progress";
      if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) return "play-services";
      return "other";
    },
  };
}

/**
 * Forgets the Google account on this device when the person signs out of Compass, so the next
 * Google sign-in shows the account picker instead of reusing the last account (a shared phone).
 * Best effort: the Compass session has already ended either way.
 */
export async function forgetGoogleAccount(): Promise<void> {
  if (!googleOffered()) return;
  try {
    const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
    if (GoogleSignin.hasPreviousSignIn()) await GoogleSignin.signOut();
  } catch (error) {
    console.warn("Google sign-out failed", error);
  }
}
