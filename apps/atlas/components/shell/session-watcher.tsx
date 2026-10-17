"use client";

import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { reauthenticate, type FormState } from "@/app/auth/actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Session continuity (Section 11.7). Tokens refresh silently through the proxy; when the session is
 * gone (`/auth/session` answers 401), a sign-in dialog opens over the page, so nothing typed on the
 * page is lost, and closes once the person signs in again. Sign-out in one tab signs every tab out
 * through BroadcastChannel.
 */
export const SESSION_CHANNEL = "xos-session";
const POLL_MS = 60_000;

export function SessionWatcher({ email }: { email: string | null }) {
  const t = useTranslations("shell.auth");
  const router = useRouter();
  const [expired, setExpired] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, form) => {
    const result = await reauthenticate(prev, form);
    if (result.ok) setExpired(false);
    return result;
  }, {});

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/auth/session", { cache: "no-store" });
        if (!cancelled && response.status === 401) setExpired(true);
      } catch (error) {
        // Offline or a network blip: the session may be fine; check again on the next tick.
        console.warn("Session check failed", error);
      }
    };
    const timer = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "signed-out") router.push("/auth/sign-in?signedOut=1");
      if (event.data.type === "preferences") router.refresh();
    };
    return () => channel.close();
  }, [router]);

  if (!expired) return null;
  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title={t("session.expiredTitle")}
      description={t("session.expiredBody")}
      actions={
        <Button type="submit" form="session-reauth" variant="primary" loading={pending}>
          {t("session.submit")}
        </Button>
      }
    >
      <form
        id="session-reauth"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        {state.error ? (
          <InlineAlert tone="danger">
            {t(`errors.${state.error}` as "errors.unexpected")}
          </InlineAlert>
        ) : null}
        <Input
          id="session-email"
          name="email"
          type="email"
          autoComplete="email"
          width="100%"
          label={t("fields.email")}
          defaultValue={state.values?.["email"] ?? email ?? ""}
        />
        <Input
          id="session-password"
          name="password"
          type="password"
          autoComplete="current-password"
          width="100%"
          label={t("fields.password")}
        />
      </form>
    </Dialog>
  );
}

/** Tells the other tabs that this one signed out or changed a preference. */
export function broadcast(type: "signed-out" | "preferences"): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type });
  channel.close();
}
