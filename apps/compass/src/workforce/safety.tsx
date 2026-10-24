/**
 * Report and block on the Workforce screens (owner decision 19): the button each item by someone else carries, and
 * the sheet it opens. Reporting and blocking go online through @xos/data/content-safety with the person's own
 * client; a block hides the person's content in every read (migration 1631), so the screen only reads again.
 */
import { blockMember, reportContent } from "@xos/data/content-safety";
import type { ContentActions, ContentActionTarget } from "@xos/workforce-native";
import { useMemo, useState, type ReactElement } from "react";
import { CONTENT_ACTIONS_TEST_ID, nounKey, type ContentNoun } from "../domain/contentSafety";
import { useCompass } from "../runtime/CompassProvider";
import { ContentSafetySheet } from "../screens/ContentSafetySheet";
import { useT } from "./kit";
import { useWorkforce } from "./runtime";

export function useContentSafety(
  noun: ContentNoun,
  onBlocked: () => void,
): { readonly contentActions: ContentActions; readonly sheet: ReactElement } {
  const t = useT();
  const wf = useWorkforce(t);
  const { network } = useCompass();
  const [target, setTarget] = useState<ContentActionTarget | null>(null);
  const contentActions = useMemo<ContentActions>(
    () => ({
      label: (author) =>
        t(`compass.safety.actions${nounKey(noun)}`, {
          name: author ?? t("compass.safety.someone"),
        }),
      onOpen: setTarget,
      testID: CONTENT_ACTIONS_TEST_ID,
    }),
    [noun, t],
  );
  const sheet = (
    <ContentSafetySheet
      target={target}
      noun={noun}
      online={network.isConnected}
      onReport={(item, reason, details) =>
        wf.online(reportContent(wf.db, { kind: item.kind, id: item.id }, reason, details))
      }
      onBlock={(membershipId) => wf.online(blockMember(wf.db, membershipId))}
      onBlocked={onBlocked}
      onClose={() => setTarget(null)}
    />
  );
  return { contentActions, sheet };
}
