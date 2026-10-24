import { OUTBOX_TABLE, type Mutation, type Row } from "@xos/sync";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Image, View } from "react-native";
import { formatCalendarDay, todayOn } from "../src/domain/dates";
import {
  applyProposal,
  buildReceiptSave,
  draftProblems,
  formatMoney,
  myExpenses,
  parseAmount,
  postableLines,
  readReceipt,
  type AuroraState,
  type BudgetLineRow,
  type CaptureSource,
  type DraftProblem,
  type ExpenseDraft,
  type ExpenseRow,
  type ReceiptProposal,
} from "../src/domain/expenses";
import { compassAuroraClient } from "../src/runtime/aurora";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { pickReceiptPhoto, processReceipt, type ReceiptImage } from "../src/runtime/receipts";
import { Gate, ProjectPicker, SyncBanner } from "../src/screens/common";
import { ReceiptCamera } from "../src/screens/ReceiptCamera";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  Screen,
  Sheet,
  Tag,
  Text,
  TextField,
  useTheme,
} from "../src/ui";

const EMPTY: ExpenseDraft = { budgetLineId: null, description: "", amount: "", incurredOn: "" };

/** What Aurora's state says above the form; read shows the AI label instead. */
const AURORA_COPY: Readonly<
  Record<Exclude<AuroraState, "read">, { tone: "info" | "warning"; key: string }>
> = {
  reading: { tone: "info", key: "compassExpenses.aurora.reading" },
  off: { tone: "info", key: "compassExpenses.aurora.off" },
  "not-in-plan": { tone: "info", key: "compassExpenses.aurora.notInPlan" },
  limit: { tone: "warning", key: "compassExpenses.aurora.limit" },
  offline: { tone: "info", key: "compassExpenses.aurora.offline" },
  "no-answer": { tone: "warning", key: "compassExpenses.aurora.noAnswer" },
  failed: { tone: "warning", key: "compassExpenses.aurora.failed" },
};

const PROBLEM_KEY: Readonly<Record<DraftProblem, string>> = {
  line: "compassExpenses.problem.line",
  description: "compassExpenses.problem.description",
  amount: "compassExpenses.problem.amount",
  date: "compassExpenses.problem.date",
  future: "compassExpenses.problem.future",
};

interface Capture {
  readonly image: ReceiptImage;
  readonly source: CaptureSource;
  readonly capturedAt: string;
}

/** The confidence key for a field Aurora read, or the missing key for one it could not, or null. */
function confidenceKey(
  proposal: ReceiptProposal | null,
  field: "description" | "amountMinor" | "incurredOn",
  path: string,
): { readonly key: string; readonly percent?: number } | null {
  if (!proposal) return null;
  const read = proposal[field];
  if (read)
    return { key: "compassExpenses.aurora.fieldRead", percent: Math.round(read.confidence * 100) };
  return proposal.missing[path] !== undefined
    ? { key: "compassExpenses.aurora.fieldMissing" }
    : null;
}

/** A field's error when it has one, else its help, else nothing (exact optional props). */
function hint(
  error: string | undefined,
  help: string | undefined,
): { error: string } | { help: string } | object {
  if (error) return { error };
  return help ? { help } : {};
}

function ReceiptForm({
  capture,
  lines,
  timeZone,
  onDone,
  onRetake,
}: {
  readonly capture: Capture;
  readonly lines: readonly BudgetLineRow[];
  readonly timeZone: string | null;
  readonly onDone: () => void;
  readonly onRetake: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, enqueue, network, config, client } = useCompass();
  const today = todayOn(timeZone);
  const [draft, setDraft] = useState<ExpenseDraft>({
    ...EMPTY,
    budgetLineId: lines.length === 1 ? (lines[0]?.id ?? null) : null,
    incurredOn: today,
  });
  const [aurora, setAurora] = useState<AuroraState>("reading");
  const [proposal, setProposal] = useState<ReceiptProposal | null>(null);
  const [picking, setPicking] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const line = lines.find((l) => l.id === draft.budgetLineId) ?? null;
  const currency = line?.currency_code ?? null;
  // A receipt in another currency than the budget's leaves the amount for the person to convert.
  const receiptCurrency = proposal?.currency?.value ?? null;
  const otherCurrency =
    receiptCurrency && currency && receiptCurrency !== currency ? receiptCurrency : null;

  // Aurora reads the receipt once, as soon as the photo is taken; the person can type while it reads.
  const reader = useMemo(
    () => compassAuroraClient(config.atlasUrl, client),
    [config.atlasUrl, client],
  );
  const online = network.isConnected;
  const photo = capture.image.base64;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  useEffect(() => {
    let live = true;
    void readReceipt(reader, photo, online)
      .then((reading) => {
        if (!live) return;
        setAurora(reading.state);
        const found = reading.proposal;
        if (!found) return;
        setProposal(found);
        setDraft(
          (current) =>
            applyProposal(
              current,
              found,
              linesRef.current.find((l) => l.id === current.budgetLineId)?.currency_code ?? null,
            ).draft,
        );
      })
      .catch(() => {
        if (live) setAurora("failed");
      });
    return () => {
      live = false;
    };
    // The photo is read once; a change of network while the form is open does not read it again.
  }, [reader, photo]);

  const problems = draftProblems(draft, currency, today);
  const save = async () => {
    setTried(true);
    if (problems.length > 0 || !line || !resolved) return;
    const amountMinor = parseAmount(draft.amount, line.currency_code);
    if (amountMinor === null) return;
    setSaving(true);
    try {
      await enqueue(
        buildReceiptSave(
          {
            personId: resolved.identity.personId,
            line,
            description: draft.description,
            amountMinor,
            incurredOn: draft.incurredOn.trim(),
            localUri: capture.image.uri,
            captureSource: capture.source,
            capturedAt: capture.capturedAt,
            // Only fields the person kept from Aurora's reading carry its provenance (Section 4.7).
            suggestionId: proposal?.suggestionId ?? null,
          },
          Date.now(),
        ),
      );
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (problem: DraftProblem) =>
    tried && problems.includes(problem) ? t(PROBLEM_KEY[problem]) : undefined;
  const confidence = (field: "description" | "amountMinor" | "incurredOn", path: string) => {
    const found = confidenceKey(proposal, field, path);
    return found
      ? t(found.key, found.percent === undefined ? {} : { percent: found.percent })
      : undefined;
  };

  return (
    <View testID="expense-form" style={{ gap: theme.space["16"] }}>
      <Image
        testID="expense-photo"
        accessibilityLabel={t("compassExpenses.form.photo")}
        source={{ uri: capture.image.uri }}
        resizeMode="contain"
        style={{
          height: theme.space["64"] * 3,
          borderRadius: theme.radius.card,
          backgroundColor: theme.color.bgRaised,
        }}
      />
      {aurora === "read" ? (
        <View style={{ gap: theme.space["8"] }} testID="expense-aurora-read">
          <Tag tone="accent" label={t("aurora.panel.aiLabel")} />
          <Text variant="text14" tone="secondary">
            {t("compassExpenses.aurora.read")}
          </Text>
        </View>
      ) : (
        <InlineAlert
          testID={`expense-aurora-${aurora}`}
          tone={AURORA_COPY[aurora].tone}
          message={t(AURORA_COPY[aurora].key)}
        />
      )}
      {otherCurrency && currency ? (
        <InlineAlert
          testID="expense-other-currency"
          tone="warning"
          message={t("compassExpenses.aurora.otherCurrency", {
            receipt: otherCurrency,
            budget: currency,
          })}
        />
      ) : null}
      <View style={{ gap: theme.space["6"] }}>
        <Text variant="label13" tone="secondary">
          {t("compassExpenses.form.line")}
        </Text>
        <Button
          testID="expense-line"
          variant="secondary"
          icon="list"
          label={
            line
              ? t("compassExpenses.form.lineChosen", {
                  number: line.line_number,
                  line: line.description,
                  budget: line.budget_name,
                })
              : t("compassExpenses.form.chooseLine")
          }
          onPress={() => setPicking(true)}
        />
        {fieldError("line") ? (
          <Text variant="text13" tone="danger">
            {fieldError("line")}
          </Text>
        ) : null}
      </View>
      <TextField
        testID="expense-description"
        label={t("compassExpenses.form.description")}
        value={draft.description}
        onChangeText={(description) => setDraft((d) => ({ ...d, description }))}
        {...hint(fieldError("description"), confidence("description", "description"))}
      />
      <TextField
        testID="expense-amount"
        label={
          currency
            ? t("compassExpenses.form.amountIn", { currency })
            : t("compassExpenses.form.amount")
        }
        keyboard="decimal"
        value={draft.amount}
        onChangeText={(amount) => setDraft((d) => ({ ...d, amount }))}
        {...hint(fieldError("amount"), confidence("amountMinor", "amount_minor"))}
      />
      <TextField
        testID="expense-date"
        label={t("compassExpenses.form.date")}
        autoComplete="off"
        value={draft.incurredOn}
        onChangeText={(incurredOn) => setDraft((d) => ({ ...d, incurredOn }))}
        {...hint(
          fieldError("date") ?? fieldError("future"),
          confidence("incurredOn", "incurred_on") ?? t("compassExpenses.form.dateHelp"),
        )}
      />
      <Button
        testID="expense-save"
        size="lg"
        block
        icon="check"
        loading={saving}
        label={t("compassExpenses.form.save")}
        onPress={() => void save()}
      />
      <Button
        testID="expense-retake"
        variant="ghost"
        block
        label={t("compassExpenses.form.retake")}
        onPress={onRetake}
      />
      <Sheet
        open={picking}
        title={t("compassExpenses.form.chooseLine")}
        closeLabel={t("compass.common.close")}
        onClose={() => setPicking(false)}
      >
        {lines.map((l) => (
          <ListRow
            key={l.id}
            testID={`expense-line-${l.line_number}`}
            icon={l.id === draft.budgetLineId ? "check" : "list"}
            title={`${l.line_number}. ${l.description}`}
            subtitle={`${l.budget_name} · ${l.currency_code}`}
            onPress={() => {
              setDraft((d) =>
                proposal
                  ? applyProposal({ ...d, budgetLineId: l.id }, proposal, l.currency_code).draft
                  : { ...d, budgetLineId: l.id },
              );
              setPicking(false);
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}

function ExpensesBody(): ReactElement {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { resolved, projectId } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const { rows: allLines } = useRows<BudgetLineRow & Row>("budget_lines");
  const { rows: expenses } = useRows<ExpenseRow & Row>("expenses");
  const { rows: projects } = useRows<Row & { time_zone?: string | null }>("projects");
  const { rows: outbox } = useRows<Row>(OUTBOX_TABLE);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [camera, setCamera] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const lines = postableLines(allLines, projectId);
  const timeZone = projects.find((p) => p.id === projectId)?.time_zone ?? null;
  const queued = new Set(
    outbox
      .map((r) => r as unknown as Mutation)
      .filter((m) => m.table === "expenses")
      .map((m) => m.rowId),
  );
  const mine = myExpenses(expenses, personId);
  const lineName = (id: string) => {
    const l = allLines.find((x) => x.id === id);
    return l ? `${l.line_number}. ${l.description}` : "";
  };
  const begin = (image: ReceiptImage, source: CaptureSource) => {
    setSaved(false);
    setCapture({ image, source, capturedAt: new Date().toISOString() });
  };
  const pick = async () => {
    setPickError(null);
    try {
      const photo = await pickReceiptPhoto();
      if (photo) begin(await processReceipt(photo.uri, photo.width, photo.height), "Photo Library");
    } catch (cause) {
      setPickError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (capture) {
    return (
      <ReceiptForm
        key={capture.capturedAt}
        capture={capture}
        lines={lines}
        timeZone={timeZone}
        onDone={() => {
          setCapture(null);
          setSaved(true);
        }}
        onRetake={() => setCapture(null)}
      />
    );
  }
  return (
    <>
      {saved ? (
        <Banner
          testID="expense-saved"
          tone="success"
          icon="circle-check"
          message={t("compassExpenses.saved")}
          onDismiss={() => setSaved(false)}
          dismissLabel={t("ui.action.dismiss")}
        />
      ) : null}
      <Card title={t("compassExpenses.add.title")}>
        <Text tone="secondary">{t("compassExpenses.add.sentence")}</Text>
        {lines.length === 0 ? (
          <InlineAlert
            testID="expense-no-lines"
            tone="info"
            message={t("compassExpenses.add.noLines")}
          />
        ) : (
          <View style={{ gap: theme.space["8"] }}>
            <Button
              testID="expense-camera"
              size="lg"
              block
              icon="camera"
              label={t("compassExpenses.add.camera")}
              onPress={() => setCamera(true)}
            />
            <Button
              testID="expense-library"
              variant="secondary"
              block
              icon="image"
              label={t("compassExpenses.add.library")}
              onPress={() => void pick()}
            />
          </View>
        )}
        {pickError ? (
          <InlineAlert tone="danger" message={t("compass.photo.failed", { reason: pickError })} />
        ) : null}
      </Card>
      <Card title={t("compassExpenses.list.title")}>
        {mine.length === 0 ? (
          <EmptyState
            testID="expenses-empty"
            icon="receipt"
            sentence={t("compassExpenses.list.empty")}
            actionLabel={t("compassExpenses.add.camera")}
          />
        ) : (
          mine.map((e) => (
            <ListRow
              key={e.id}
              testID={`expense-row-${e.id}`}
              icon="receipt"
              title={e.description}
              subtitle={[
                formatMoney(e.amount_minor, e.currency_code, i18n.language),
                formatCalendarDay(e.incurred_on, i18n.language),
                lineName(e.budget_line_id),
              ]
                .filter(Boolean)
                .join(" · ")}
              trailing={
                <Tag
                  tone={
                    queued.has(e.id)
                      ? "warning"
                      : e.expense_state === "Rejected"
                        ? "danger"
                        : "neutral"
                  }
                  label={
                    queued.has(e.id)
                      ? t("compassExpenses.list.waiting")
                      : t(`compassExpenses.state.${e.expense_state.toLowerCase()}`, {
                          defaultValue: e.expense_state,
                        })
                  }
                />
              }
            />
          ))
        )}
      </Card>
      <ReceiptCamera
        open={camera}
        onClose={() => setCamera(false)}
        onImage={(image) => begin(image, "Camera")}
      />
    </>
  );
}

/**
 * Expenses (Section 4.3 item 11, A92): photograph a receipt or pick one, let Aurora read it when the org has
 * document extraction on, check the fields, choose the budget line and save. The save works offline: it waits in
 * the offline queue with its photo and files once on reconnect.
 */
export default function ExpensesScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <Screen
      testID="expenses"
      title={t("nav.compass.more.expenses")}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <ProjectPicker />
      <SyncBanner />
      <Gate feature="expenses.submit">
        <ExpensesBody />
      </Gate>
    </Screen>
  );
}
