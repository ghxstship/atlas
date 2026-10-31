import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { loadReceivableOrders } from "../data/receiveOrders";
import {
  buildOrderReceipt,
  receiveSheetLines,
  removeScannedTag,
  setReceiveQuantity,
  startReceiveSheet,
  type ReceivableOrder,
  type ReceiveSheet,
} from "../domain/scan";
import { useCompass } from "../runtime/CompassProvider";
import { Button, EmptyState, IconButton, ListRow, Sheet, Text, TextField, useTheme } from "../ui";

/**
 * Receive against an order (R7a): the project's Approved or Sent orders and their open lines, read online. Scanned
 * codes fill the tag list of the chosen serialized line (the scan screen hands them to `sheet`); steppers set the
 * other quantities. Submit queues one app.receive_goods mutation through the outbox, so it survives going offline
 * and a replay records nothing twice.
 */
export function ReceiveOrderSheet({
  open,
  sheet,
  onSheet,
  onClose,
  onQueued,
}: {
  readonly open: boolean;
  readonly sheet: ReceiveSheet | null;
  readonly onSheet: (next: ReceiveSheet | null) => void;
  readonly onClose: () => void;
  readonly onQueued: (count: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, projectId, enqueue } = useCompass();
  const [orders, setOrders] = useState<ReceivableOrder[] | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || !projectId) return;
    let live = true;
    setOrders(undefined);
    void loadReceivableOrders(client, projectId).then((found) => {
      if (live) setOrders(found);
    });
    return () => {
      live = false;
    };
  }, [open, projectId, client, attempt]);

  const submit = () => {
    if (!sheet) return;
    const mutation = buildOrderReceipt(sheet, note, Date.now());
    if (!mutation) return;
    const count = receiveSheetLines(sheet).reduce((n, l) => n + l.quantity, 0);
    void enqueue(mutation);
    setNote("");
    onSheet(null);
    onQueued(count);
  };

  let body: ReactElement;
  if (sheet) {
    const counted = receiveSheetLines(sheet).length > 0;
    body = (
      <View testID="receive-order-lines" style={{ gap: theme.space["8"] }}>
        <Text variant="label13" tone="secondary">
          {t("compass.scan.receiveOrder.scanHint")}
        </Text>
        {sheet.order.lines.map((l) => {
          const tags = sheet.tags[l.poLineId] ?? [];
          const quantity = sheet.quantities[l.poLineId] ?? 0;
          return l.serialized ? (
            <View key={l.poLineId} style={{ gap: theme.space["4"] }}>
              <ListRow
                testID={`receive-line-${l.lineNumber}`}
                icon={sheet.activeLineId === l.poLineId ? "check" : "package"}
                title={`${l.lineNumber}. ${l.description}`}
                subtitle={t("compass.scan.receiveOrder.tagged", {
                  count: tags.length,
                  open: l.open,
                })}
                onPress={() => onSheet({ ...sheet, activeLineId: l.poLineId })}
              />
              {tags.map((tag) => (
                <ListRow
                  key={tag}
                  testID={`receive-tag-${tag}`}
                  title={tag}
                  trailing={
                    <IconButton
                      icon="minus"
                      label={t("compass.scan.receiveOrder.removeTag", { tag })}
                      onPress={() => onSheet(removeScannedTag(sheet, l.poLineId, tag))}
                    />
                  }
                />
              ))}
            </View>
          ) : (
            <ListRow
              key={l.poLineId}
              testID={`receive-line-${l.lineNumber}`}
              icon="package"
              title={`${l.lineNumber}. ${l.description}`}
              subtitle={t("compass.scan.receiveOrder.counted", { count: quantity, open: l.open })}
              trailing={
                <View style={{ flexDirection: "row", gap: theme.space["4"] }}>
                  <IconButton
                    testID={`receive-less-${l.lineNumber}`}
                    icon="minus"
                    label={t("compass.scan.receiveOrder.less", { line: l.description })}
                    onPress={() => onSheet(setReceiveQuantity(sheet, l.poLineId, quantity - 1))}
                  />
                  <IconButton
                    testID={`receive-more-${l.lineNumber}`}
                    icon="plus"
                    label={t("compass.scan.receiveOrder.more", { line: l.description })}
                    onPress={() => onSheet(setReceiveQuantity(sheet, l.poLineId, quantity + 1))}
                  />
                </View>
              }
            />
          );
        })}
        <TextField
          label={t("compass.scan.receiveOrder.note")}
          value={note}
          onChangeText={setNote}
        />
        <Button
          testID="receive-order-submit"
          size="lg"
          block
          disabled={!counted}
          label={t("compass.scan.receiveOrder.submit")}
          onPress={submit}
        />
        <Button
          variant="secondary"
          block
          label={t("compass.scan.receiveOrder.otherOrder")}
          onPress={() => onSheet(null)}
        />
      </View>
    );
  } else if (orders === undefined) {
    body = (
      <Text variant="text14" tone="secondary">
        {t("compass.scan.receiveOrder.loading")}
      </Text>
    );
  } else if (orders === null) {
    body = (
      <EmptyState
        testID="receive-order-offline"
        icon="package"
        sentence={t("compass.scan.receiveOrder.offline")}
        actionLabel={t("compass.scan.receiveOrder.retry")}
        onAction={() => setAttempt((n) => n + 1)}
      />
    );
  } else if (orders.length === 0) {
    body = (
      <EmptyState
        testID="receive-order-none"
        icon="package"
        sentence={t("compass.scan.receiveOrder.none")}
        actionLabel={t("compass.scan.receiveOrder.close")}
        onAction={onClose}
      />
    );
  } else {
    body = (
      <View testID="receive-order-list" style={{ gap: theme.space["8"] }}>
        {orders.map((o) => (
          <ListRow
            key={o.purchaseOrderId}
            testID={`receive-order-${o.poNumber}`}
            icon="clipboard-list"
            title={t("compass.scan.receiveOrder.order", { number: o.poNumber })}
            subtitle={o.vendorName ?? t("compass.scan.receiveOrder.unnamedVendor")}
            onPress={() => onSheet(startReceiveSheet(o))}
          />
        ))}
      </View>
    );
  }

  return (
    <Sheet
      open={open}
      title={t("compass.scan.receiveOrder.title")}
      closeLabel={t("compass.scan.receiveOrder.close")}
      onClose={onClose}
    >
      {body}
    </Sheet>
  );
}
