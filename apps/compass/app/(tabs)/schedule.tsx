import type { Row } from "@xos/sync";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { operationalEngagements } from "../../src/domain/access";
import {
  actionFor,
  buildShiftAction,
  claimConflict,
  groupByDay,
  isMine,
  isOpenShift,
  startsIn,
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

export default function ScheduleScreen(): ReactElement {
  const { t } = useTranslation();
  const roleTitle = useRoleTitle();
  const { resolved, projectId, enqueue, refresh, orgSettings } = useCompass();
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
    const countdown = startsIn(s.starts_at, now);
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
        stateLabel={t(`compass.schedule.${state}`)}
        {...(countdown ? { countdown: t("compass.schedule.startsIn", { time: countdown }) } : {})}
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
          ) : undefined
        }
      />
    );
  };
  const days = groupByDay(mine, now, (iso, tz) => formatDay(iso, tz));
  return (
    <Screen testID="schedule" title={t("compass.schedule.title")} onRefresh={() => void refresh()}>
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
          icon="calendar"
          sentence={t("compass.schedule.empty")}
          actionLabel={t("compass.common.refresh")}
          onAction={() => void refresh()}
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
          <Text variant="heading20" heading>
            {t("compass.schedule.openShifts")}
          </Text>
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
