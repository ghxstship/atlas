import { useState, type ReactElement } from "react";
import { Button, ListRow, SegmentedControl, Sheet, StateChip, TextField } from "@xos/ui-native";
import {
  LOST_ITEM_CATEGORIES,
  type LostItem,
  type LostItemCategory,
  type LostItemState,
} from "@xos/data/workforce-site";
import {
  Empty,
  Stack,
  WorkforceFrame,
  defined,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

/** What a crew member enters when they log a found item. */
export interface LostItemDraft {
  readonly category: LostItemCategory;
  readonly description: string;
  readonly foundLocation: string;
  readonly storageLocation: string | null;
}

export interface LostFoundScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly log: string;
  readonly failed: string;
  readonly sheetTitle: string;
  readonly close: string;
  readonly category: string;
  readonly description: string;
  readonly foundLocation: string;
  readonly storageLocation: string;
  readonly save: string;
  readonly categories: Readonly<Record<LostItemCategory, string>>;
  readonly states: Readonly<Record<LostItemState, string>>;
  readonly itemTitle: (category: string, description: string) => string;
  /** Row subtitle: item number, where it was found and how many claims wait. */
  readonly meta: (number: string, foundLocation: string, openClaims: number) => string;
}

export interface LostFoundScreenProps {
  readonly status: ScreenStatus;
  readonly labels: LostFoundScreenLabels;
  readonly items: readonly LostItem[];
  readonly onLog: Action<[draft: LostItemDraft]>;
  /** Opens an item to review claims, return or dispose (Atlas holds the full workflow). */
  readonly onOpenItem: (itemId: string) => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

const STATE_CHIP = {
  Logged: "ready",
  Claimed: "in-review",
  Returned: "complete",
  Disposed: "canceled",
} as const;

/** Compass Lost and Found: found items with their state, and a sheet to log one. */
export function LostFoundScreen({
  status,
  labels,
  items,
  onLog,
  onOpenItem,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: LostFoundScreenProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<LostItemCategory>("Bag");
  const [description, setDescription] = useState("");
  const [found, setFound] = useState("");
  const [storage, setStorage] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const close = () => {
    setOpen(false);
    setDescription("");
    setFound("");
    setStorage("");
  };
  const save = async () => {
    const draft: LostItemDraft = {
      category,
      description: description.trim(),
      foundLocation: found.trim(),
      storageLocation: storage.trim() === "" ? null : storage.trim(),
    };
    if (await run("log", () => onLog(draft))) close();
  };
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-lost-found"
      footer={
        <Button
          label={labels.log}
          variant="primary"
          icon="package"
          block
          onPress={() => setOpen(true)}
        />
      }
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {items.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.log} onAction={() => setOpen(true)} />
      ) : (
        items.map((i) => (
          <ListRow
            key={i.id}
            title={labels.itemTitle(labels.categories[i.category], i.description)}
            subtitle={labels.meta(
              i.number,
              i.foundLocation,
              i.claims.filter((c) => c.decidedAt === null).length,
            )}
            onPress={() => onOpenItem(i.id)}
            trailing={
              <StateChip state={STATE_CHIP[i.state]} label={labels.states[i.state]} compact />
            }
          />
        ))
      )}
      <Sheet
        open={open}
        title={labels.sheetTitle}
        closeLabel={labels.close}
        onClose={close}
        footer={
          <Button
            label={labels.save}
            variant="primary"
            block
            disabled={description.trim() === "" || found.trim() === ""}
            loading={busy === "log"}
            onPress={() => void save()}
          />
        }
      >
        <Stack>
          {alert}
          <SegmentedControl
            label={labels.category}
            value={category}
            options={LOST_ITEM_CATEGORIES.map((c) => ({ value: c, label: labels.categories[c] }))}
            onChange={(v) => setCategory(v as LostItemCategory)}
          />
          <TextField
            label={labels.description}
            value={description}
            onChangeText={setDescription}
            multiline
          />
          <TextField label={labels.foundLocation} value={found} onChangeText={setFound} />
          <TextField label={labels.storageLocation} value={storage} onChangeText={setStorage} />
        </Stack>
      </Sheet>
    </WorkforceFrame>
  );
}
