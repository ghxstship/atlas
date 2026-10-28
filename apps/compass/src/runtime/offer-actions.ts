/**
 * Push actions for offers and messages on the device (A127, ADR 0089): registers the shift offer, engagement offer
 * and message categories with their Accept, Decline and Reply actions, and answers each through notifications.act
 * without opening Compass. It sits beside useActionableNotifications (runtime/notifications.ts), which keeps the
 * approval category, the device registration and every tap on a notification body; each listener reads only the
 * actions of its own categories, so neither answers the other's.
 */
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  CATEGORY_ACTIONS,
  doneMessageKey,
  needsUnlock,
  offerActRequest,
  readOfferOutcome,
  readOfferResponse,
  REPLY_ACTION,
  DECLINE_ACTION,
  type OfferAction,
  type OfferCategory,
} from "../domain/offer-actions";
import type { ActionResponseLike } from "../domain/notifications";
import { useCompass } from "./CompassProvider";

type Translate = (key: string, values?: Record<string, string>) => string;

const BUTTON_KEYS: Readonly<Record<OfferAction, string>> = {
  accept: "compass.offerActions.accept",
  decline: "compass.offerActions.decline",
  reply: "compass.offerActions.reply",
};

async function registerOfferCategories(t: Translate): Promise<void> {
  for (const [category, actions] of Object.entries(CATEGORY_ACTIONS) as [
    OfferCategory,
    readonly OfferAction[],
  ][]) {
    await Notifications.setNotificationCategoryAsync(
      category,
      actions.map((action) => ({
        identifier: action,
        buttonTitle: t(BUTTON_KEYS[action]),
        ...(action === REPLY_ACTION
          ? {
              textInput: {
                submitButtonTitle: t("compass.offerActions.send"),
                placeholder: t("compass.offerActions.replyPrompt"),
              },
            }
          : {}),
        options: {
          opensAppToForeground: false,
          isDestructive: action === DECLINE_ACTION,
          isAuthenticationRequired: needsUnlock(category, action),
        },
      })),
    );
  }
}

/** Responses already answered in this run, so a replayed last response never acts twice. */
const handled = new Set<string>();

/**
 * Wires the offer and message actions once Compass is signed in: the categories and their response listener, the
 * response that launched Compass included. Mount it beside useActionableNotifications.
 */
export function useOfferActions(): void {
  const { t } = useTranslation();
  const { client, config } = useCompass();
  const tRef = useRef<Translate>(t as Translate);
  tRef.current = t as Translate;

  useEffect(() => {
    void registerOfferCategories(tRef.current).catch(() => undefined);
  }, []);

  useEffect(() => {
    const respond = async (response: ActionResponseLike): Promise<void> => {
      const request = readOfferResponse(response);
      if (!request) return;
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.has(key)) return;
      handled.add(key);
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
      const call = offerActRequest(config.atlasUrl, request, token);
      const outcome = await fetch(call.url, call.init)
        .then((res) => readOfferOutcome(request, res))
        .catch(() => ({ kind: "failed" }) as const);
      await Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(
        () => undefined,
      );
      if (outcome.kind === "done") await confirm(tRef.current(doneMessageKey(request)));
      else if (outcome.kind === "refused")
        await confirm(tRef.current("compass.notifications.refused", { detail: outcome.detail }));
      else await confirm(tRef.current("compass.notifications.failed"));
    };
    // An action that launched Compass arrives before this listener; answer it too.
    const last = Notifications.getLastNotificationResponse();
    if (last) void respond(last as ActionResponseLike);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void respond(response as ActionResponseLike);
    });
    return () => subscription.remove();
  }, [client, config.atlasUrl]);
}
