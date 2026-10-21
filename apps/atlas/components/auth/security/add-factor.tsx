"use client";

import { Button } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSecurityCopy } from "./copy";
import { SecurityKeyEnrollment } from "./security-key-enrollment";
import { TotpEnrollment } from "./totp-enrollment";

/**
 * Adds a second factor from Personal settings, Security: an authenticator app, or a security key when the
 * relying party is configured. The page reloads its list once the factor verifies.
 */
export function AddFactor({ securityKeys }: { securityKeys: boolean }) {
  const t = useSecurityCopy();
  const router = useRouter();
  const [adding, setAdding] = useState<"totp" | "webauthn" | null>(null);
  const finished = () => {
    router.refresh();
  };
  if (adding === "totp") {
    return <TotpEnrollment onDone={finished} idPrefix="add-totp" />;
  }
  if (adding === "webauthn") return <SecurityKeyEnrollment onDone={finished} />;
  return (
    <div className="flex flex-wrap gap-8">
      <Button type="button" variant="secondary" icon="Smartphone" onClick={() => setAdding("totp")}>
        {t("enroll.start")}
      </Button>
      {securityKeys ? (
        <Button type="button" variant="secondary" icon="Lock" onClick={() => setAdding("webauthn")}>
          {t("enroll.addKey")}
        </Button>
      ) : null}
    </div>
  );
}
