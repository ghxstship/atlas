/**
 * Push notifications on the device (journey 57, ADR 0030): registers the approval request category with
 * its Approve and Reject actions, asks for permission from the Inbox, registers the device's Expo push
 * token for the member's org in app.push_subscriptions and for the person (app.register_push_device,
 * A101), answers an action through notifications.act without opening the record, and opens the target of
 * every other tap, the one that launched Compass included. The Inbox lists the person's notifications.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  actRequest,
  APPROVAL_CATEGORY,
  APPROVE_ACTION,
  needsRecordLookup,
  readActionResponse,
  readActOutcome,
  REJECT_ACTION,
  tapRoute,
  type ActionResponseLike,
  type InboxNotificationRow,
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

/**
 * Registers this device for the person's pushes; skipped where push is unavailable. A member's device is
 * registered with their org (app.push_subscriptions); every signed-in person's device is registered as their
 * own too (A101), which carries the pushes of orgs they work with as an external party whenever they have
 * no device registered there.
 */
async function registerDevice(client: SupabaseClient, membershipId: string | null): Promise<void> {
  const projectId = (Constants.expoConfig?.extra?.["eas"] as { projectId?: string } | undefined)
    ?.projectId;
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {});
  const platform = Platform.OS === "android" ? "android" : "ios";
  await client.rpc("register_push_device", { p_expo_push_token: token.data, p_platform: platform });
  if (!membershipId) return;
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
    platform,
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
  const personId = resolved?.identity.personId ?? null;
  // A tap that launched Compass opens its target once the navigator can take it.
  const navigationReady =
    (useRootNavigationState() as { readonly key?: string } | undefined)?.key !== undefined;
  const tRef = useRef<Translate>(t as Translate);
  tRef.current = t as Translate;

  useEffect(() => {
    let live = true;
    void (async () => {
      await registerCategories(tRef.current);
      const permission = await Notifications.getPermissionsAsync();
      if (live && permission.granted && personId) {
        // A simulator or an unsigned build has no push token; actions on delivered pushes still work.
        await registerDevice(client, membershipId).catch(() => undefined);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, membershipId, personId]);

  useEffect(() => {
    if (!navigationReady) return undefined;
    const respond = async (response: ActionResponseLike): Promise<void> => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.has(key)) return;
      handled.add(key);
      // A tap on the notification itself opens its target: the record, the deep link, else the Inbox (A101).
      const route = tapRoute(response);
      if (route !== null) {
        Notifications.clearLastNotificationResponse();
        router.push(route as never);
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
    // A response that launched Compass, from a tap or an action, arrives before this listener; answer it too.
    const last = Notifications.getLastNotificationResponse();
    if (last) void respond(last as ActionResponseLike);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void respond(response as ActionResponseLike);
    });
    return () => subscription.remove();
  }, [client, config.atlasUrl, router, navigationReady]);
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
  const personId = resolved?.identity.personId ?? null;
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
    if (p.granted && personId) await registerDevice(client, membershipId).catch(() => undefined);
  }, [client, membershipId, personId]);
  return { state, request };
}

type Raw = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The person's latest notifications, through app.inbox_items under their own row level security (members,
 * external parties and marketplace matches alike), with each org's slug and, for a notification about a
 * record that carries no key, the key read from the record and its project. Null when offline.
 */
async function loadInboxNotifications(
  client: SupabaseClient,
): Promise<readonly (InboxNotificationRow & { readonly section: string })[] | null> {
  const items = await client
    .from("inbox_items")
    .select(
      "id, org_id, created_at, kind, subject_table, subject_id, message_args, read_at, section",
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(25);
  if (items.error) return null;
  const raw = (items.data ?? []) as Raw[];
  const orgIds = [...new Set(raw.map((r) => String(r["org_id"])))];
  const orgs =
    orgIds.length === 0
      ? { data: [] as Raw[] }
      : await client.from("organizations").select("id, slug").in("id", orgIds);
  const slugs = new Map(
    ((orgs.data ?? []) as Raw[]).map((o) => [String(o["id"]), text(o["slug"])]),
  );
  const rows = raw.map((r) => ({
    id: String(r["id"]),
    kind: String(r["kind"]),
    createdAt: String(r["created_at"]),
    read: r["read_at"] !== null && r["read_at"] !== undefined,
    args:
      r["message_args"] && typeof r["message_args"] === "object"
        ? (r["message_args"] as Raw)
        : ({} as Raw),
    subjectTable: text(r["subject_table"]),
    subjectId: text(r["subject_id"]),
    orgSlug: slugs.get(String(r["org_id"])) ?? null,
    lookedUpRecordKey: null as string | null,
    section: String(r["section"]),
  }));
  // The sender's own fallback: a notification about a record that carries no key opens the record it names.
  const recordIds = rows.filter(needsRecordLookup).map((r) => r.subjectId as string);
  if (recordIds.length === 0) return rows;
  const records = await client
    .from("records")
    .select("id, project_id, record_number")
    .in("id", recordIds);
  const projectIds = [
    ...new Set(((records.data ?? []) as Raw[]).map((r) => String(r["project_id"]))),
  ];
  const projects =
    projectIds.length === 0
      ? { data: [] as Raw[] }
      : await client.from("projects").select("id, project_key").in("id", projectIds);
  const projectKeys = new Map(
    ((projects.data ?? []) as Raw[]).map((p) => [String(p["id"]), text(p["project_key"])]),
  );
  const keys = new Map(
    ((records.data ?? []) as Raw[]).map((r) => [
      String(r["id"]),
      `${projectKeys.get(String(r["project_id"])) ?? ""}-${String(r["record_number"] ?? "")}`,
    ]),
  );
  return rows.map((r) =>
    r.subjectId !== null && keys.has(r.subjectId)
      ? { ...r, lookedUpRecordKey: keys.get(r.subjectId) ?? null }
      : r,
  );
}

/**
 * The Inbox's notifications (A101): read when the Inbox opens and again on demand. Offline, the last list
 * read stays; Compass holds no notification on the device.
 */
export function useInboxNotifications(): {
  readonly rows: readonly (InboxNotificationRow & { readonly section: string })[];
  readonly reload: () => void;
} {
  const { client, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const [rows, setRows] = useState<
    readonly (InboxNotificationRow & { readonly section: string })[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!personId) return undefined;
    let live = true;
    void loadInboxNotifications(client)
      .then((next) => {
        if (live && next) setRows(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, personId, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { rows, reload };
}
