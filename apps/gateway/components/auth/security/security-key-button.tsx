"use client";

import { createCredential, getCredential } from "@xos/data/webauthn-json";
import { Button, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { securityKeyChallengeAction, securityKeyVerifyAction } from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";

/**
 * Verifies a security key or passkey enrolled as a second factor: the server issues the challenge, the browser
 * asks the authenticator, the server verifies. Continues to `next`, or runs `onVerified`.
 */
export function SecurityKeyButton({
  factorId,
  label,
  next,
  onVerified,
  variant = "secondary",
}: {
  factorId: string;
  label: string;
  next?: string;
  onVerified?: () => void;
  variant?: "primary" | "secondary";
}) {
  const t = useSecurityCopy();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [prompting, setPrompting] = useState(false);

  const run = () =>
    start(async () => {
      setError(null);
      const challenge = await securityKeyChallengeAction(factorId);
      if (!challenge.ok) return setError(challenge.error);
      const { ceremony, challengeId } = challenge.data;
      setPrompting(true);
      const result =
        ceremony.kind === "create"
          ? await createCredential(ceremony.options)
          : await getCredential(ceremony.options);
      setPrompting(false);
      if (!result.ok) return setError(result.reason);
      const verified = await securityKeyVerifyAction({
        factorId,
        challengeId,
        kind: ceremony.kind,
        credential: result.credential,
      });
      if (!verified.ok) return setError(verified.error);
      if (next) router.replace(next as never);
      else onVerified?.();
    });

  return (
    <div className="flex flex-col gap-8">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      {prompting ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("challenge.keyPrompt")}
        </p>
      ) : null}
      <Button
        type="button"
        variant={variant}
        icon="Lock"
        loading={pending}
        onClick={run}
        className="w-full"
      >
        {label}
      </Button>
    </div>
  );
}
