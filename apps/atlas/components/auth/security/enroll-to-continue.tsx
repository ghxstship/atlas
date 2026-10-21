"use client";

import { useRouter } from "next/navigation";
import { TotpEnrollment } from "./totp-enrollment";

/** Sets up an authenticator app an org requires, then continues where the person was going. */
export function EnrollToContinue({ next }: { next: string }) {
  const router = useRouter();
  return (
    <TotpEnrollment
      variant="primary"
      idPrefix="required"
      onDone={() => {
        router.replace(next as never);
        router.refresh();
      }}
    />
  );
}
