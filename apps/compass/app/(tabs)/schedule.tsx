import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useRouter, type Href } from "expo-router";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ScrollView } from "react-native";
import { View } from "react-native";
import { elsewhereLink, operationalEngagements } from "../../src/domain/access";
import {
  actionFor,
  buildShiftAction,
  claimConflict,
  groupByDay,
  isMine,
  isOpenShift,
  shiftCountdown,
  type ShiftRow,
} from "../../src/domain/shifts";
import { claimRuleOf } from "../../src/domain/settings";
import { useCompass, useRows } from "../../src/runtime/CompassProvider";
import {
  formatDay,
  formatTime,
  ProjectPicker,
  SyncBanner,
  useRoleTitle,
} from "../../src/screens/common";
import { Button, EmptyState, InlineAlert, Screen, ShiftCard, Text } from "../../src/ui";
import { WalletButton } from "../../src/screens/WalletButton";

export default function ScheduleScreen(): ReactElement {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const router = useRouter();
  const { resolved, projectId, enqueue, refresh, config, orgSettings } = useCompass();
  const scrollRef = useRef<ScrollView>(null);
  const [openY, setOpenY] = useState(0);
  // scheduling.open_shift_claiming for this project (migration 1322).
  const rule = claimRuleOf(orgSettings);
  const identity = resolved?.identity;
  const { rows } = useRows<ShiftRow & Row>("shifts", (s) => s.project_id === projectId);
  const now = Date.now();
  const me = {
    membershipId: identity?.membershipId ?? null,
    engagementIds: identity ? operationalEngagements(identity, null).map((e) => e.id) : [],
  };
  const mine = rows.filter((s) => isMine(s, me));
  const open = rows.filter(isOpenShift);
  const [notice, setNotice] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const held = mine.filter((s) => s.membership_id === me.membershipId);
  const act = (s: ShiftRow, action: "accept" | "claim") => {
    if (action === "claim") {
      const conflict = claimConflict(s, held);
      if (conflict) {
        setNotice({
          tone: "warning",
          text: t("compass.schedule.claimOverlap", {
            time: `${formatDay(conflict.starts_at, conflict.time_zone)} ${formatTime(conflict.starts_at, conflict.time_zone)}`,
          }),
        });
        return;
      }
      setNotice({
        tone: "success",
        text: t(
          rule === "first-come" ? "compass.schedule.claimQueued" : "compass.schedule.claimSent",
        ),
      });
    }
    void enqueue(
      buildShiftAction(s, action, identity?.membershipId === null, me.membershipId, rule),
    );
  };
  const card = (s: ShiftRow) => {
    const action = actionFor(s, me);
    const state =
      s.shift_state === "Accepted"
        ? "accepted"
        : s.shift_state === "Canceled"
          ? "canceled"
          : "published";
    const countdown = shiftCountdown(s.starts_at, now);
    return (
      <ShiftCard
        key={s.id}
        testID={`schedule-shift-${s.id}`}
        state={
          s.shift_state === "Accepted"
            ? "active"
            : s.shift_state === "Canceled"
              ? "canceled"
              : "scheduled"
        }
        // An open shift is nobody's yet: it reads Open, never Waiting for you (finding A59-022).
        stateLabel={t(isOpenShift(s) ? "compass.schedule.open" : `compass.schedule.${state}`)}
        {...(countdown ? { countdown: t(countdown.key, countdown.values) } : {})}
        role={roleTitle(s)}
        date={formatDay(s.starts_at, s.time_zone)}
        time={t("compass.schedule.timeRange", {
          start: formatTime(s.starts_at, s.time_zone),
          end: formatTime(s.ends_at, s.time_zone),
        })}
        place={t("compass.schedule.noPlace")}
        actions={
          action ? (
            <Button
              testID={`shift-${action}-${s.id}`}
              label={t(`compass.schedule.${action}`)}
              onPress={() => act(s, action)}
            />
          ) : s.shift_state === "Accepted" ? (
            // An accepted shift as a pass in Wallet (Section 11.10 item 14, A65-011 part 4).
            <WalletButton kind="shift" id={s.id} testID={`shift-wallet-${s.id}`} />
          ) : undefined
        }
      />
    );
  };
  const days = groupByDay(mine, now, (iso, tz) => formatDay(iso, tz));
  // A teaching empty state (Section 11.10 item 10, finding A59-026): the action that fills My shifts,
  // never Refresh. Members claim an open shift or ask a teammate; external people are booked by the
  // organization on their engagement, in Gateway.
  const empty = !me.membershipId
    ? {
        sentence: "compass.schedule.emptyExternal",
        action: "compass.common.openGateway",
        onAction: () => {
          if (identity) void Linking.openURL(elsewhereLink(identity.audience, config).url);
        },
      }
    : open.length > 0
      ? {
          sentence: "compass.schedule.emptyClaim",
          action: "compass.schedule.findOpen",
          onAction: () => scrollRef.current?.scrollTo({ y: openY, animated: true }),
        }
      : {
          sentence: "compass.schedule.emptyAsk",
          action: "compass.schedule.messageTeammate",
          onAction: () => router.push("/workforce/chat" as Href),
        };
  return (
    <Screen
      testID="schedule"
      title={t("compass.schedule.title")}
      onRefresh={() => void refresh()}
      scrollRef={scrollRef}
    >
      <ProjectPicker />
      <SyncBanner />
      {notice ? (
        <InlineAlert testID="schedule-notice" tone={notice.tone} message={notice.text} />
      ) : null}
      <Text variant="heading20" heading>
        {t("compass.schedule.myShifts")}
      </Text>
      {days.length === 0 ? (
        <EmptyState
          testID="schedule-empty"
          icon="calendar"
          sentence={t(empty.sentence)}
          actionLabel={t(empty.action)}
          onAction={empty.onAction}
        />
      ) : null}
      {days.map((d) => [
        <Text key={d.day} variant="label13" tone="secondary">
          {d.day}
        </Text>,
        ...d.shifts.map(card),
      ])}
      {me.membershipId ? (
        <>
          <View onLayout={(e) => setOpenY(e.nativeEvent.layout.y)}>
            <Text variant="heading20" heading>
              {t("compass.schedule.openShifts")}
            </Text>
          </View>
          {open.length === 0 ? (
            <Text tone="secondary">{t("compass.schedule.openEmpty")}</Text>
          ) : (
            open.map(card)
          )}
        </>
      ) : null}
    </Screen>
  );
}
