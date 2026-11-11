/**
 * Sign Out in Compass ends this device's session only. Supabase's signOut() defaults to the global scope, which
 * revokes every session the person holds: a second phone, Atlas and Gateway in a browser. Ending the other sessions is
 * the separate Security action (Settings, Security, Sessions: signOutOtherSessions), never a side effect of Sign Out.
 */

/** The scope of a plain Sign Out: this device's refresh token, nobody else's. */
export const THIS_DEVICE = { scope: "local" } as const;

export interface SignOutDependencies {
  readonly auth: { signOut(options: typeof THIS_DEVICE): Promise<unknown> };
  /** The running sync session wipes the device's rows and queue; without one, the store is wiped directly. */
  readonly syncSession: { remoteSignOut(): Promise<unknown> } | null;
  readonly store: { wipe(): Promise<unknown> } | null;
}

/** Wipes what the device holds for the person, then ends this device's session. */
export async function signOutThisDevice({
  auth,
  syncSession,
  store,
}: SignOutDependencies): Promise<void> {
  if (syncSession) await syncSession.remoteSignOut();
  else if (store) await store.wipe();
  await auth.signOut(THIS_DEVICE);
}
