import type { ReactElement } from "react";
import { Avatar, Button, Card, SegmentedControl, Tag, Text, TextField } from "@xos/ui-native";
import { telHref, type DirectoryPerson } from "@xos/data/workforce-chat";
import {
  Empty,
  Stack,
  WorkforceFrame,
  defined,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface DirectoryScreenLabels extends FrameLabels {
  readonly search: string;
  readonly empty: string;
  readonly clearSearch: string;
  readonly scope: string;
  readonly everyone: string;
  readonly onSiteNow: string;
  readonly onSite: string;
  readonly call: (name: string) => string;
  readonly message: (name: string) => string;
  readonly recognitions: (count: number) => string;
}

export interface DirectoryScreenProps {
  readonly status: ScreenStatus;
  readonly labels: DirectoryScreenLabels;
  /** On-site members first, as listWorkforceDirectory returns them. */
  readonly people: readonly DirectoryPerson[];
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onSiteOnly: boolean;
  readonly onScopeChange: (onSiteOnly: boolean) => void;
  /** Dials a tel: link through the platform. */
  readonly onCall: (href: string) => void;
  readonly onMessage: (membershipId: string) => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass Directory: who is on site now (geofence-verified), with call and message. */
export function DirectoryScreen({
  status,
  labels,
  people,
  search,
  onSearch,
  onSiteOnly,
  onScopeChange,
  onCall,
  onMessage,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: DirectoryScreenProps): ReactElement {
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-directory"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      <TextField label={labels.search} value={search} onChangeText={onSearch} />
      <SegmentedControl
        label={labels.scope}
        value={onSiteOnly ? "site" : "all"}
        options={[
          { value: "all", label: labels.everyone },
          { value: "site", label: labels.onSiteNow },
        ]}
        onChange={(v) => onScopeChange(v === "site")}
      />
      {people.length === 0 ? (
        <Empty
          sentence={labels.empty}
          actionLabel={labels.clearSearch}
          onAction={() => {
            onSearch("");
            onScopeChange(false);
          }}
        />
      ) : (
        people.map((p) => {
          const name = p.preferredName ?? p.name;
          const tel = telHref(p.workPhone);
          return (
            <Card key={p.membershipId} title={name} {...defined({ meta: p.headline ?? undefined })}>
              <Stack>
                <Stack row>
                  <Avatar name={name} />
                  {p.onSite ? <Tag tone="success" label={labels.onSite} /> : null}
                  {p.roles.map((r) => (
                    <Tag key={r} label={r} />
                  ))}
                </Stack>
                {p.recognitionCount !== null && p.recognitionCount > 0 ? (
                  <Text variant="text13" tone="secondary">
                    {labels.recognitions(p.recognitionCount)}
                  </Text>
                ) : null}
                <Stack row>
                  {tel !== null ? (
                    <Button label={labels.call(name)} icon="phone" onPress={() => onCall(tel)} />
                  ) : null}
                  <Button
                    label={labels.message(name)}
                    icon="message-square"
                    onPress={() => onMessage(p.membershipId)}
                  />
                </Stack>
              </Stack>
            </Card>
          );
        })
      )}
    </WorkforceFrame>
  );
}
