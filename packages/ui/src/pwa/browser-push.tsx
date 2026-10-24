"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Button } from "../Button/Button.tsx";
import { Card } from "../Surface/Surface.tsx";
import {
  currentPushSubscription,
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "./client.ts";

/** The app's copy for the browser notifications setting (A96); apps pass their own catalog strings. */
export interface BrowserPushLabels {
  readonly title: string;
  readonly body: string;
  readonly turnOn: string;
  readonly turnOff: string;
  readonly on: string;
  readonly off: string;
  readonly blocked: string;
  readonly unsupported: string;
  readonly unavailable: string;
  readonly failed: string;
}

export interface BrowserPushSettingProps {
  /** The VAPID public key, base64url; null when the platform has not set one up. */
  readonly vapidPublicKey: string | null;
  readonly labels: BrowserPushLabels;
  /** Saves the subscription (PushSubscription.toJSON()) for the signed-in person; false when it did not. */
  readonly onRegister: (subscription: PushSubscriptionJSON) => Promise<boolean>;
  /** Revokes this browser's endpoint for the signed-in person. */
  readonly onRevoke: (endpoint: string) => Promise<boolean>;
}

type State = "loading" | "on" | "off" | "blocked" | "unsupported" | "unavailable";

/**
 * Browser notifications for this browser (Section 4.10, A65-023): turned on only when the person asks, which is
 * when the browser asks its permission, and off again in one action. Quiet hours and channel choices stay with the
 * notification settings around it, since browser pushes ride the Push channel.
 */
export function BrowserPushSetting({
  vapidPublicKey,
  labels,
  onRegister,
  onRevoke,
}: BrowserPushSettingProps): ReactElement {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const settle = (next: State) => {
      if (live) setState(next);
    };
    if (vapidPublicKey === null) settle("unavailable");
    else if (!pushSupported()) settle("unsupported");
    else if (Notification.permission === "denied") settle("blocked");
    else
      void currentPushSubscription().then(
        (s) => settle(s ? "on" : "off"),
        () => settle("off"),
      );
    return () => {
      live = false;
    };
  }, [vapidPublicKey]);

  const turnOn = async () => {
    if (vapidPublicKey === null) return;
    setBusy(true);
    setFailed(false);
    const result = await subscribeToPush(vapidPublicKey);
    if (!result.ok) {
      if (result.reason === "blocked") setState("blocked");
      else if (result.reason === "unsupported") setState("unsupported");
      else setFailed(true);
    } else if (await onRegister(result.subscription)) setState("on");
    else {
      await unsubscribeFromPush();
      setFailed(true);
    }
    setBusy(false);
  };

  const turnOff = async () => {
    setBusy(true);
    setFailed(false);
    const endpoint = await unsubscribeFromPush();
    if (endpoint !== null && !(await onRevoke(endpoint))) setFailed(true);
    setState("off");
    setBusy(false);
  };

  const status =
    state === "on"
      ? labels.on
      : state === "off"
        ? labels.off
        : state === "blocked"
          ? labels.blocked
          : state === "unsupported"
            ? labels.unsupported
            : state === "unavailable"
              ? labels.unavailable
              : "";
  return (
    <Card title={labels.title}>
      <p className="m-0 text-text-13 text-text-secondary">{labels.body}</p>
      <p role="status" className="m-0 text-text-13" data-push-state={state}>
        {status}
      </p>
      {state === "on" ? (
        <Button onClick={() => void turnOff()} disabled={busy}>
          {labels.turnOff}
        </Button>
      ) : state === "off" ? (
        <Button variant="primary" icon="Bell" onClick={() => void turnOn()} disabled={busy}>
          {labels.turnOn}
        </Button>
      ) : null}
      {failed ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {labels.failed}
        </span>
      ) : null}
    </Card>
  );
}
