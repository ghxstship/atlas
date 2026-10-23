"use client";

import { getCredential, webAuthnAvailable } from "@xos/data/webauthn-json";
import { Button, InlineAlert } from "@xos/ui";
import { useState, useSyncExternalStore, useTransition } from "react";
import { finishPasskeySignInAction, startPasskeySignInAction } from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";

const subscribeNever = () => () => undefined;

/**
 * Sign in with a passkey (Section 11.10 rule 13: passwordless first). The browser offers the passkeys it holds for
 * this site; the server verifies the signature and writes the session. A person who also holds a second factor
 * then verifies it, as after any first factor.
 */
export function PasskeySignInButton({ next }: { next: string }) {
  const t = useSecurityCopy();
  const supported = useSyncExternalStore(subscribeNever, webAuthnAvailable, () => false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!supported) return null;
  const signIn = () =>
    start(async () => {
      setError(null);
      const options = await startPasskeySignInAction();
      if (!options.ok) return setError(options.error);
      const result = await getCredential(options.data.options);
      if (!result.ok) return setError(result.reason);
      const finished = await finishPasskeySignInAction({
        challengeId: options.data.challengeId,
        credential: result.credential,
        next,
      });
      if (!finished.ok) setError(finished.error);
    });
  return (
    <div className="flex flex-col gap-8">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      <Button type="button" icon="Lock" loading={pending} onClick={signIn} className="w-full">
        {t("passkeys.signIn")}
      </Button>
    </div>
  );
}
