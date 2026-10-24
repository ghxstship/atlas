/**
 * The content safety sheet (ADR 0033 decision 57, App Store Review Guideline 1.2): report someone else's post, message or
 * shout-out to the org's moderators, or block its author. The Feed, a conversation and Recognition open it from the
 * button on each item by someone else. Reporting asks for a reason and optional details; blocking asks once more,
 * says what it hides and that the person is not told, and the screen behind reads its rows again without theirs.
 * Both go online: the sheet says so instead of queueing.
 */
import type { ContentReportReason } from "@xos/data/content-safety";
import type { ActionResult, ContentActionTarget } from "@xos/workforce-native";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  CONTENT_REPORT_REASONS,
  canBlock,
  firstStep,
  nounKey,
  REASON_KEYS,
  REASON_PICKER_TEST_ID,
  REASON_SLUGS,
  reasonOfSlug,
  REPORT_DETAILS_MAX,
  REPORT_RESPONSE_HOURS,
  type ContentNoun,
  type SafetyStep,
} from "../domain/contentSafety";
import { Button, InlineAlert, SegmentedControl, Sheet, Text, TextField, useTheme } from "../ui";

export interface ContentSafetySheetProps {
  /** The item the sheet is about; null keeps it closed. */
  readonly target: ContentActionTarget | null;
  readonly noun: ContentNoun;
  /** Whether the device is online; both actions need the server. */
  readonly online: boolean;
  readonly onReport: (
    target: ContentActionTarget,
    reason: ContentReportReason,
    details: string,
  ) => Promise<ActionResult>;
  readonly onBlock: (membershipId: string) => Promise<ActionResult>;
  /** After a block, so the screen reads its rows again without the blocked person's. */
  readonly onBlocked: () => void;
  readonly onClose: () => void;
}

export function ContentSafetySheet({
  target,
  noun,
  online,
  onReport,
  onBlock,
  onBlocked,
  onClose,
}: ContentSafetySheetProps): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const [step, setStep] = useState<SafetyStep>("menu");
  const [reason, setReason] = useState<ContentReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Every item opens on its first step with nothing chosen.
  useEffect(() => {
    if (!target) return;
    setStep(firstStep(target));
    setReason(null);
    setDetails("");
    setProblem(null);
  }, [target]);

  const name = target?.authorName ?? t("compass.safety.someone");
  const suffix = nounKey(noun);
  const run = async (action: () => Promise<ActionResult>, next: SafetyStep) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await action();
      if (result.ok) setStep(next);
      else setProblem(result.message);
      return result.ok;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!target || reason === null) return;
    await run(() => onReport(target, reason, details.trim()), "reported");
  };
  const block = async () => {
    const membershipId = target?.authorMembershipId;
    if (!membershipId) return;
    if (await run(() => onBlock(membershipId), "blocked")) onBlocked();
  };

  const title =
    step === "report"
      ? t(`compass.safety.report${suffix}`)
      : step === "reported"
        ? t("compass.safety.reportedTitle")
        : step === "confirm-block"
          ? t("compass.safety.confirmTitle", { name })
          : step === "blocked"
            ? t("compass.safety.blockedTitle")
            : t("compass.safety.title");

  return (
    <Sheet
      open={target !== null}
      title={title}
      closeLabel={t("compass.safety.close")}
      onClose={onClose}
      testID="content-safety"
    >
      <View style={{ gap: theme.space["12"] }}>
        {!online && step !== "reported" && step !== "blocked" ? (
          <InlineAlert
            testID="content-safety-offline"
            tone="warning"
            message={t("compass.safety.offline")}
          />
        ) : null}
        {problem ? (
          <InlineAlert tone="danger" title={t("compass.safety.failed")} message={problem} />
        ) : null}
        {step === "menu" && target ? (
          <>
            <Text tone="secondary">
              {t("compass.safety.intro", { hours: REPORT_RESPONSE_HOURS })}
            </Text>
            <Button
              testID="content-report"
              label={t(`compass.safety.report${suffix}`)}
              icon="flag"
              variant="secondary"
              block
              onPress={() => setStep("report")}
            />
            {canBlock(target) ? (
              <Button
                testID="content-block"
                label={t("compass.safety.block", { name })}
                icon="user-minus"
                variant="secondary"
                block
                onPress={() => setStep("confirm-block")}
              />
            ) : null}
          </>
        ) : null}
        {step === "report" ? (
          <>
            <Text variant="label13">{t("compass.safety.reasonTitle")}</Text>
            {/* A radio group, so a screen reader says which reason is chosen. */}
            <SegmentedControl
              testID={REASON_PICKER_TEST_ID}
              label={t("compass.safety.reasonTitle")}
              value={reason === null ? "" : REASON_SLUGS[reason]}
              options={CONTENT_REPORT_REASONS.map((r) => ({
                value: REASON_SLUGS[r],
                label: t(`compass.safety.reasons.${REASON_KEYS[r]}`),
              }))}
              onChange={(slug) => setReason(reasonOfSlug(slug))}
            />
            <TextField
              testID="report-details"
              label={t("compass.safety.details")}
              value={details}
              onChangeText={(v) => setDetails(v.slice(0, REPORT_DETAILS_MAX))}
              multiline
            />
            <Button
              testID="report-submit"
              label={t("compass.safety.submit")}
              block
              disabled={reason === null || !online}
              loading={busy}
              onPress={() => void send()}
            />
          </>
        ) : null}
        {step === "reported" && target ? (
          <>
            <Text testID="report-sent">
              {t("compass.safety.reported", { hours: REPORT_RESPONSE_HOURS })}
            </Text>
            {canBlock(target) ? (
              <Button
                testID="report-block"
                label={t("compass.safety.blockToo", { name })}
                icon="user-minus"
                variant="secondary"
                block
                onPress={() => setStep("confirm-block")}
              />
            ) : null}
            <Button testID="report-done" label={t("compass.safety.done")} block onPress={onClose} />
          </>
        ) : null}
        {step === "confirm-block" ? (
          <>
            <Text>{t("compass.safety.confirm", { name })}</Text>
            <Button
              testID="block-confirm"
              label={t("compass.safety.blockConfirm")}
              variant="danger"
              block
              disabled={!online}
              loading={busy}
              onPress={() => void block()}
            />
            <Button
              testID="block-cancel"
              label={t("compass.safety.cancel")}
              variant="ghost"
              block
              onPress={onClose}
            />
          </>
        ) : null}
        {step === "blocked" ? (
          <>
            <Text testID="block-done-sentence">{t("compass.safety.blocked", { name })}</Text>
            <Button testID="block-done" label={t("compass.safety.done")} block onPress={onClose} />
          </>
        ) : null}
      </View>
    </Sheet>
  );
}
