import { COMPASS_AURORA_ENTRY } from "@xos/ai/conversation";
import type { SuggestionView, Turn } from "@xos/ai/conversation";
import { isInternal } from "@xos/sync";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { compassConversation } from "../../src/runtime/aurora";
import { useCompass } from "../../src/runtime/CompassProvider";
import { DenialNotice } from "../../src/screens/common";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  RefusalNotice,
  Screen,
  Skeleton,
  Tag,
  Text,
  TextField,
  useTheme,
} from "../../src/ui";

/**
 * The Compass assistant (COMPASS_AURORA_ENTRY, A25): ask about shifts, SOPs and the handbook. Answers
 * come only from records the person can see, every answer is labeled as AI-generated, and a proposed
 * change is written only after the person confirms it (Section 4.7). External parties have no member
 * org for the assistant, so the screen refuses them with the role notice.
 */
export default function AuroraScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, config, client } = useCompass();
  const conversation = useMemo(
    () => compassConversation(config.atlasUrl, client),
    [config.atlasUrl, client],
  );
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const [question, setQuestion] = useState("");
  const internal = resolved ? isInternal(resolved.identity.audience) : false;

  useEffect(() => {
    if (internal) void conversation.loadStatus();
  }, [conversation, internal]);

  const title = t(COMPASS_AURORA_ENTRY.labelKey);
  if (!resolved) {
    return (
      <Screen testID="aurora" title={title}>
        <Skeleton lines={3} />
      </Screen>
    );
  }
  if (!internal) {
    return (
      <Screen testID="aurora" title={title}>
        <DenialNotice reason="role" />
      </Screen>
    );
  }

  const availability = state.availability;
  const ask = () => {
    const q = question;
    setQuestion("");
    void conversation.ask(q);
  };

  return (
    <Screen
      testID="aurora"
      title={title}
      footer={
        availability.kind === "ready" ? (
          <View style={{ gap: theme.space["8"] }}>
            <TextField
              testID="aurora-question"
              label={t("aurora.panel.inputLabel")}
              help={t("compass.aurora.inputHelp")}
              value={question}
              onChangeText={setQuestion}
              multiline
            />
            <Button
              testID="aurora-ask"
              size="lg"
              block
              icon="sparkles"
              label={t("aurora.panel.send")}
              loading={state.busy}
              disabled={state.busy || question.trim().length === 0}
              onPress={ask}
            />
          </View>
        ) : undefined
      }
    >
      <InlineAlert testID="aurora-notice" tone="info" message={t("aurora.panel.aiNotice")} />
      {availability.kind === "loading" ? (
        <>
          <Text tone="secondary">{t("aurora.panel.loadingStatus")}</Text>
          <Skeleton lines={2} />
        </>
      ) : availability.kind === "not-in-plan" ? (
        <RefusalNotice
          testID="aurora-not-in-plan"
          outcome="REFUSE"
          title={t("aurora.notInPlan.title")}
          reason={t("compass.aurora.notInPlan")}
        />
      ) : availability.kind === "off" ? (
        <RefusalNotice
          testID="aurora-off"
          outcome="REFUSE"
          title={t("compass.aurora.offTitle")}
          reason={t("aurora.off.actionMember")}
        />
      ) : availability.kind === "limit-reached" ? (
        <RefusalNotice
          testID="aurora-limit"
          outcome="REFUSE"
          title={t("aurora.limit.title")}
          reason={t("compass.aurora.limit", { allowance: availability.allowance })}
        />
      ) : availability.kind === "error" ? (
        <ErrorState
          testID="aurora-status-error"
          title={t("aurora.statusError.title")}
          sentence={t("aurora.statusError.sentence")}
          actionLabel={t("aurora.statusError.retry")}
          onRetry={() => void conversation.loadStatus()}
        />
      ) : state.turns.length === 0 ? (
        <EmptyState
          testID="aurora-empty"
          icon="sparkles"
          sentence={t(COMPASS_AURORA_ENTRY.descriptionKey)}
          actionLabel={t("aurora.empty.action")}
        />
      ) : (
        <>
          {state.turns.map((turn) => (
            <TurnCard key={turn.id} turn={turn} onConfirm={conversation} />
          ))}
          <Button
            testID="aurora-new"
            variant="ghost"
            label={t("aurora.panel.newConversation")}
            onPress={() => conversation.clear()}
          />
        </>
      )}
    </Screen>
  );
}

function TurnCard({
  turn,
  onConfirm,
}: {
  readonly turn: Turn;
  readonly onConfirm: Pick<ReturnType<typeof compassConversation>, "confirm" | "reject">;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Card testID={`aurora-turn-${turn.id}`} title={turn.question}>
      <View style={{ gap: theme.space["8"] }}>
        {turn.phase === "asking" ? (
          <Text tone="secondary">{t("aurora.panel.asking")}</Text>
        ) : turn.phase === "answered" && turn.answer ? (
          <>
            <Tag tone="accent" label={t("aurora.panel.aiLabel")} />
            <Text>{turn.answer.text}</Text>
            {turn.answer.citations.length > 0 ? (
              <Text variant="text13" tone="secondary">
                {t("aurora.panel.citations")}
                {": "}
                {turn.answer.citations.map((c) => c.label).join(", ")}
              </Text>
            ) : null}
            {turn.model ? (
              <Text variant="text12" tone="tertiary">
                {t("aurora.panel.modelLabel", { model: turn.model })}
              </Text>
            ) : null}
          </>
        ) : turn.phase === "no-answer" ? (
          <InlineAlert
            tone="warning"
            title={t("aurora.noAnswer.title")}
            message={turn.missing ?? t("compass.aurora.noAnswer")}
          />
        ) : turn.phase === "refused" ? (
          <InlineAlert
            tone="danger"
            title={t("aurora.refused.title")}
            message={turn.problem?.detail ?? ""}
          />
        ) : turn.phase === "failed" ? (
          <InlineAlert
            tone="danger"
            title={t("aurora.failed.title")}
            message={t("aurora.failed.sentence")}
          />
        ) : (
          <InlineAlert
            tone="danger"
            title={t("aurora.error.title")}
            message={t("aurora.error.sentence")}
          />
        )}
        {turn.suggestions.map((s) => (
          <SuggestionRow key={s.id} turnId={turn.id} suggestion={s} actions={onConfirm} />
        ))}
      </View>
    </Card>
  );
}

function SuggestionRow({
  turnId,
  suggestion: s,
  actions,
}: {
  readonly turnId: number;
  readonly suggestion: SuggestionView;
  readonly actions: Pick<ReturnType<typeof compassConversation>, "confirm" | "reject">;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View testID={`aurora-suggestion-${s.id}`} style={{ gap: theme.space["4"] }}>
      <Text variant="label13">{t("aurora.suggestions.heading")}</Text>
      <Text>{s.summary}</Text>
      {s.phase === "loading" ? (
        <Text tone="secondary">{t("aurora.suggestions.loading")}</Text>
      ) : s.phase === "applied" ? (
        <Text tone="success">{t("aurora.suggestions.applied")}</Text>
      ) : s.phase === "rejected" ? (
        <Text tone="secondary">{t("aurora.suggestions.rejected")}</Text>
      ) : s.phase === "refused" ? (
        <Text tone="danger">
          {t("aurora.suggestions.refused", { detail: s.problem?.detail ?? "" })}
        </Text>
      ) : s.phase === "error" ? (
        <Text tone="danger">
          {t("aurora.suggestions.error", { detail: s.problem?.detail ?? "" })}
        </Text>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["8"] }}>
          <Button
            testID={`aurora-confirm-${s.id}`}
            label={t("aurora.suggestions.confirm")}
            loading={s.phase === "confirming"}
            onPress={() => void actions.confirm(turnId, s.id, t("compass.aurora.confirmReason"))}
          />
          <Button
            testID={`aurora-reject-${s.id}`}
            variant="ghost"
            label={t("aurora.suggestions.reject")}
            disabled={s.phase === "confirming"}
            onPress={() => void actions.reject(turnId, s.id, t("compass.aurora.rejectReason"))}
          />
        </View>
      )}
    </View>
  );
}
