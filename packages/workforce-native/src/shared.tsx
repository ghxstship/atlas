import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { EmptyState, ErrorState, InlineAlert, Screen, Skeleton, Text } from "@xos/ui-native";
import { useTheme } from "@xos/ui-native/theme";

/**
 * Shared pieces of the Workforce screens. Every string arrives translated through `labels`, the
 * convention of @xos/ui-native: Compass owns the i18next catalogs (namespace "workforce") and the
 * data calls, and each screen only draws and reports what the person did.
 */

/** Where a screen's data stands: loading shows a skeleton, error shows the retry state. */
export type ScreenStatus = "loading" | "error" | "ready";

/** What an action reports back: a refusal carries the server's sentence (SQLSTATE XR001). */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** An action a screen hands to the app; it resolves with the outcome so the screen can show it. */
export type Action<A extends unknown[] = []> = (...args: A) => Promise<ActionResult>;

/** The strings every screen frame needs. */
export interface FrameLabels {
  readonly title: string;
  readonly loading: string;
  readonly errorTitle: string;
  readonly errorSentence: string;
  readonly retry: string;
}

/** The frame strings with a screen-specific title, such as a course or conversation name. */
export function titled(labels: FrameLabels, title: string): FrameLabels {
  return {
    title,
    loading: labels.loading,
    errorTitle: labels.errorTitle,
    errorSentence: labels.errorSentence,
    retry: labels.retry,
  };
}

/** Drops undefined values so optional props stay absent under exactOptionalPropertyTypes. */
export function defined<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export interface FrameProps {
  readonly status: ScreenStatus;
  readonly labels: FrameLabels;
  readonly errorReference?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly refreshing?: boolean | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly footer?: ReactNode;
  readonly testID?: string | undefined;
  readonly children: ReactNode;
}

/** A Workforce screen: the title, then a skeleton, the error state or the content. */
export function WorkforceFrame({
  status,
  labels,
  errorReference,
  onRetry,
  refreshing,
  onRefresh,
  footer,
  testID,
  children,
}: FrameProps): ReactElement {
  return (
    <Screen
      title={labels.title}
      {...defined({ refreshing, onRefresh, testID })}
      {...(status === "ready" && footer !== undefined ? { footer } : {})}
    >
      {status === "loading" ? (
        <View aria-label={labels.loading} aria-busy>
          <Skeleton lines={4} />
        </View>
      ) : status === "error" ? (
        <ErrorState
          title={labels.errorTitle}
          sentence={labels.errorSentence}
          {...defined({ reference: errorReference, onRetry })}
          {...(onRetry === undefined ? {} : { actionLabel: labels.retry })}
        />
      ) : (
        children
      )}
    </Screen>
  );
}

/** The empty state with its one next action. */
export function Empty({
  sentence,
  actionLabel,
  onAction,
  icon,
}: {
  sentence: string;
  actionLabel: string;
  onAction?: (() => void) | undefined;
  icon?: string;
}): ReactElement {
  return (
    <EmptyState sentence={sentence} actionLabel={actionLabel} {...defined({ onAction, icon })} />
  );
}

/** A titled group of rows. */
export function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}): ReactElement {
  const theme = useTheme();
  return (
    <View {...defined({ testID })} style={{ gap: theme.space["8"] }}>
      <Text heading variant="heading16">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Stacks children with the standard gap. */
export function Stack({
  children,
  row = false,
}: {
  children: ReactNode;
  row?: boolean;
}): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: theme.space["8"],
        ...(row ? { flexDirection: "row" as const, flexWrap: "wrap" as const } : {}),
      }}
    >
      {children}
    </View>
  );
}

/**
 * Runs actions one at a time: `busy` names the running one, and a refusal or failure stays on
 * screen as an alert until the next action. A thrown error is shown too, never swallowed.
 */
export function useActionRunner(failedLabel: string): {
  busy: string | null;
  run: (key: string, action: () => Promise<ActionResult>) => Promise<boolean>;
  alert: ReactElement | null;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, action: () => Promise<ActionResult>): Promise<boolean> => {
      setBusy(key);
      setMessage(null);
      try {
        const result = await action();
        if (!result.ok) setMessage(result.message);
        return result.ok;
      } catch (error: unknown) {
        setMessage(error instanceof Error && error.message !== "" ? error.message : failedLabel);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [failedLabel],
  );
  const alert =
    message === null ? null : <InlineAlert tone="danger" title={failedLabel} message={message} />;
  return { busy, run, alert };
}
