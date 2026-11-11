/**
 * Pieces the identity settings screens share (ADR 0070): the offline notices, the answer to a save, and the
 * confirmation sheet for a change that cannot be undone.
 */
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { refusalReason } from "../../domain/queue-summary";
import type { WriteState } from "../../settings/writes";
import { Button, InlineAlert, SegmentedControl, Sheet, Text, useTheme } from "../../ui";

const C = "compassSettings.common";

/**
 * Says why a control is disabled or what happens to a change offline: `queues` for a section whose changes save on
 * the phone, `needs` for one that needs the server's answer, and `first` for a section never opened online here.
 */
export function OfflineNotice({
  kind,
  testID,
}: {
  readonly kind: "queues" | "needs" | "first";
  readonly testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const key =
    kind === "queues" ? "offlineQueues" : kind === "needs" ? "offlineNeeds" : "offlineFirst";
  return (
    <InlineAlert
      testID={testID ?? `settings-offline-${kind}`}
      tone="warning"
      message={t(`${C}.${key}`)}
    />
  );
}

/**
 * The answer to a queued change: saved, saved on the phone until the connection is back, or refused with the rule's
 * own sentence when the screen knows it (`ruleKey`), else the server's.
 */
export function WriteNotice({
  state,
  ruleKey,
  testID,
}: {
  readonly state: WriteState;
  /** The message key for a refusal rule the screen names, or undefined to show the server's sentence. */
  readonly ruleKey?: (rule: string) => string | undefined;
  readonly testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  switch (state.kind) {
    case "saved":
      return <InlineAlert testID={`${testID}-saved`} tone="success" message={t(`${C}.saved`)} />;
    case "queued":
      return <InlineAlert testID={`${testID}-queued`} tone="info" message={t(`${C}.queued`)} />;
    case "refused": {
      const own = state.rule ? ruleKey?.(state.rule) : undefined;
      const reason = refusalReason({ code: state.code, message: state.message });
      return (
        <InlineAlert
          testID={`${testID}-refused`}
          tone="danger"
          message={
            own
              ? t(own)
              : reason.key === "refusedReason"
                ? t("compass.queue.refusedMessage", reason.values)
                : t(`compass.queue.${reason.key}`)
          }
        />
      );
    }
    default:
      return null;
  }
}

/** A choice with its label shown above it, as a text field shows its label (the control only announces it). */
export function LabeledChoice({
  label,
  value,
  options,
  onChange,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: { value: string; label: string }[];
  readonly onChange: (value: string) => void;
  readonly testID: string;
}): ReactElement {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space["6"] }}>
      <Text variant="label13" tone="secondary">
        {label}
      </Text>
      <SegmentedControl
        testID={testID}
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </View>
  );
}

/** Asks before a change that cannot be undone from the phone, such as leaving an org or signing out a device. */
export function ConfirmSheet({
  open,
  title,
  sentence,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onClose,
  testID,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly sentence: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Sheet
      testID={testID}
      open={open}
      title={title}
      closeLabel={t("compass.common.close")}
      onClose={onClose}
    >
      <View style={{ gap: theme.space["16"] }}>
        <Text tone="secondary">{sentence}</Text>
        {error ? <InlineAlert testID={`${testID}-error`} tone="danger" message={error} /> : null}
        <Button
          testID={`${testID}-confirm`}
          variant={danger ? "danger" : "primary"}
          block
          loading={busy ?? false}
          label={confirmLabel}
          onPress={onConfirm}
        />
        <Button
          testID={`${testID}-cancel`}
          variant="ghost"
          block
          label={t("compass.common.cancel")}
          onPress={onClose}
        />
      </View>
    </Sheet>
  );
}
