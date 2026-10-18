/**
 * Push notifications on the device (journey 57, ADR 0030): registers the approval request category with
 * its Approve and Reject actions, asks for permission from the Inbox, registers the device's Expo push
 * token in app.push_subscriptions, and answers an action through notifications.act without opening
 * the record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  actRequest,
  APPROVAL_CATEGORY,
  APPROVE_ACTION,
  isApprovalTap,
  readActionResponse,
  readActOutcome,
  REJECT_ACTION,
  type ActionResponseLike,
} from "../domain/notifications";
import { useCompass } from "./CompassProvider";

// Notifications that arrive while Compass is open still show, so the actions stay one press away.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

type Translate = (key: string, values?: Record<string, string>) => string;

async function registerCategories(t: Translate): Promise<void> {
  await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: t("compass.notifications.approve"),
      options: { opensAppToForeground: false, isAuthenticationRequired: true },
    },
    {
      identifier: REJECT_ACTION,
      buttonTitle: t("compass.notifications.reject"),
      textInput: {
        submitButtonTitle: t("compass.notifications.reject"),
        placeholder: t("compass.notifications.reason"),
      },
      options: { opensAppToForeground: false, isDestructive: true, isAuthenticationRequired: true },
    },
  ]);
}

/** Registers this device for the member's pushes; skipped where push is unavailable. */
async function registerDevice(client: SupabaseClient, membershipId: string): Promise<void> {
  const projectId = (Constants.expoConfig?.extra?.["eas"] as { projectId?: string } | undefined)
    ?.projectId;
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {});
  const existing = await client
    .from("push_subscriptions")
    .select("id")
    .eq("membership_id", membershipId)
    .eq("expo_push_token", token.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing.data) {
    await client
      .from("push_subscriptions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.data.id);
    return;
  }
  await client.from("push_subscriptions").insert({
    membership_id: membershipId,
    expo_push_token: token.data,
    platform: Platform.OS === "android" ? "android" : "ios",
  });
}

/** Responses already answered in this run, so a replayed last response never acts twice. */
const handled = new Set<string>();

/**
 * Wires actionable notifications once Compass is signed in: the approval category and the response
 * handler, and the device registration when the person already allowed notifications. Asking for
 * permission waits for the Inbox (useNotificationPermission), so no prompt interrupts sign-in.
 * Mount it under CompassProvider when the phase is ready.
 */
export function useActionableNotifications(): void {
  const { t } = useTranslation();
  const router = useRouter();
  const { client, config, resolved } = useCompass();
  const membershipId = resolved?.identity.membershipId ?? null;
  const tRef = useRef<Translate>(t as Translate);
  tRef.current = t as Translate;

  useEffect(() => {
    let live = true;
    void (async () => {
      await registerCategories(tRef.current);
      const permission = await Notifications.getPermissionsAsync();
      if (live && permission.granted && membershipId) {
        // A simulator or an unsigned build has no push token; actions on delivered pushes still work.
        await registerDevice(client, membershipId).catch(() => undefined);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, membershipId]);

  useEffect(() => {
    const respond = async (response: ActionResponseLike): Promise<void> => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.has(key)) return;
      handled.add(key);
      if (isApprovalTap(response)) {
        router.push("/inbox" as never);
        return;
      }
      const request = readActionResponse(response);
      if (!request) return;
      const confirm = (body: string) =>
        Notifications.scheduleNotificationAsync({
          content: { title: request.title ?? tRef.current("compass.notifications.title"), body },
          trigger: null,
        });
      const token = (await client.auth.getSession()).data.session?.access_token;
      if (!token) {
        await confirm(tRef.current("compass.notifications.signedOut"));
        return;
      }
      const call = actRequest(config.atlasUrl, request, token);
      const outcome = await fetch(call.url, call.init)
        .then((res) => readActOutcome(request, res))
        .catch(() => ({ kind: "failed" }) as const);
      await Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(
        () => undefined,
      );
      if (outcome.kind === "done") {
        await confirm(
          tRef.current(
            outcome.action === APPROVE_ACTION
              ? "compass.notifications.approved"
              : "compass.notifications.rejected",
          ),
        );
      } else if (outcome.kind === "refused") {
        await confirm(tRef.current("compass.notifications.refused", { detail: outcome.detail }));
      } else {
        await confirm(tRef.current("compass.notifications.failed"));
      }
    };
    // A response that launched Compass in the background arrives before this listener; answer it too.
    const last = Notifications.getLastNotificationResponse();
    if (last) void respond(last as ActionResponseLike);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void respond(response as ActionResponseLike);
    });
    return () => subscription.remove();
  }, [client, config.atlasUrl, router]);
}

export type PermissionState = "unknown" | "granted" | "ask" | "denied";

/**
 * Notification permission for the Inbox's prompt: asked in context, when the person chooses to approve
 * from notifications, and the device registered once they allow it.
 */
export function useNotificationPermission(): {
  readonly state: PermissionState;
  readonly request: () => Promise<void>;
} {
  const { client, resolved } = useCompass();
  const membershipId = resolved?.identity.membershipId ?? null;
  const [state, setState] = useState<PermissionState>("unknown");
  useEffect(() => {
    let live = true;
    void Notifications.getPermissionsAsync().then((p) => {
      if (live) setState(p.granted ? "granted" : p.canAskAgain ? "ask" : "denied");
    });
    return () => {
      live = false;
    };
  }, []);
  const request = useCallback(async () => {
    const p = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    setState(p.granted ? "granted" : p.canAskAgain ? "ask" : "denied");
    if (p.granted && membershipId)
      await registerDevice(client, membershipId).catch(() => undefined);
  }, [client, membershipId]);
  return { state, request };
}
