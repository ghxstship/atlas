// The clock Live Activity on the Lock Screen and in the Dynamic Island (SIM-005, journey 52; Section 11.13
// Clock; Section 13: "the running shift timer and the next cue"). Shows on shift since, the break, the worked
// time and the next cue, with Break and Clock Out buttons that run ClockPunchIntent without opening Compass.
// Clocked out with a cue close, it shows the next cue alone ("cue" state, no buttons). The home screen
// widgets are in CompassWidgets.swift. expo-target.config.json declares this extension; @bacons/apple-targets
// generates it at prebuild, links _shared/ into the app target too, and mirrors the app's App Group into it.
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

extension Color {
  /// The XOS accent (tokens accentDefault: light #4f57d9, dark #5b63e8), declared in code so prebuild
  /// generates no asset catalog into the target's source folder.
  static let compassAccent = Color(UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0x5b / 255, green: 0x63 / 255, blue: 0xe8 / 255, alpha: 1)
      : UIColor(red: 0x4f / 255, green: 0x57 / 255, blue: 0xd9 / 255, alpha: 1)
  })
}

@main
struct ClockActivityBundle: WidgetBundle {
  var body: some Widget {
    ClockLiveActivity()
    TodayWidget()
    NextCueWidget()
  }
}

struct ClockLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ClockActivityAttributes.self) { context in
      // The system background adapts to the Lock Screen's appearance, and the default text colors follow it.
      ClockLockScreenView(context: context)
        .activitySystemActionForegroundColor(Color.compassAccent)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          ClockStatusLabel(context: context)
        }
        DynamicIslandExpandedRegion(.trailing) {
          ClockTimer(state: context.state)
            .font(.title2.monospacedDigit().weight(.semibold))
            .multilineTextAlignment(.trailing)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.projectName)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if context.state.state != "cue" {
            VStack(spacing: 8) {
              NextCueRow(context: context)
              ClockButtons(context: context)
            }
          }
        }
      } compactLeading: {
        Image(systemName: symbol(context.state))
          .foregroundStyle(Color.compassAccent)
      } compactTrailing: {
        ClockTimer(state: context.state)
          .font(.caption.monospacedDigit())
          .frame(maxWidth: 56)
      } minimal: {
        Image(systemName: symbol(context.state))
          .foregroundStyle(Color.compassAccent)
      }
      .keylineTint(Color.compassAccent)
    }
  }
}

private func symbol(_ state: ClockActivityAttributes.ContentState) -> String {
  switch state.state {
  case "break": return "cup.and.saucer.fill"
  case "cue": return "music.mic"
  default: return "clock.fill"
  }
}

/// Worked time: a running timer while working, frozen during a break; in the cue state, the time to the cue.
struct ClockTimer: View {
  let state: ClockActivityAttributes.ContentState

  var body: some View {
    if state.state == "break" {
      Text(Duration.seconds(state.workedBaseSeconds).formatted(.time(pattern: .hourMinuteSecond)))
    } else if state.state == "cue" {
      CueCountdown(at: state.nextCueAt ?? state.segmentStart)
    } else {
      Text(timerInterval: state.segmentStart...Date.distantFuture, countsDown: false)
    }
  }
}

/// Time to a cue: counting down until it is due, then its planned time once it is late.
struct CueCountdown: View {
  let at: Date

  var body: some View {
    if at > Date() {
      Text(timerInterval: Date()...at, countsDown: true)
    } else {
      Text(at, style: .time)
    }
  }
}

struct ClockStatusLabel: View {
  let context: ActivityViewContext<ClockActivityAttributes>

  var body: some View {
    let onBreak = context.state.state == "break"
    if context.state.state == "cue" {
      VStack(alignment: .leading, spacing: 2) {
        Label(context.attributes.nextCueTitle ?? "", systemImage: "music.mic")
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text(context.state.nextCueLabel ?? "")
          .font(.headline)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
          .foregroundStyle(Color.compassAccent)
      }
    } else {
      VStack(alignment: .leading, spacing: 2) {
        Label(onBreak ? context.attributes.onBreakLabel : context.attributes.onShiftLabel,
              systemImage: onBreak ? "cup.and.saucer.fill" : "clock.fill")
          .font(.headline)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
          .foregroundStyle(onBreak ? Color.orange : Color.compassAccent)
        if onBreak, let since = context.state.breakSince {
          HStack(spacing: 4) {
            Text(context.attributes.sinceLabel)
            Text(timerInterval: since...Date.distantFuture, countsDown: false)
              .monospacedDigit()
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        } else {
          HStack(spacing: 4) {
            Text(context.attributes.sinceLabel)
            Text(context.state.onShiftSince, style: .time)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
      }
    }
  }
}

/// The next cue beside the shift: its name and the time to it. Nothing when there is no cue.
struct NextCueRow: View {
  let context: ActivityViewContext<ClockActivityAttributes>

  var body: some View {
    if let label = context.state.nextCueLabel, let at = context.state.nextCueAt {
      HStack(spacing: 6) {
        Image(systemName: "music.mic")
          .foregroundStyle(Color.compassAccent)
        Text(context.attributes.nextCueTitle ?? "")
          .foregroundStyle(.secondary)
        Text(label)
          .fontWeight(.semibold)
          .lineLimit(1)
        Spacer()
        CueCountdown(at: at)
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 80)
      }
      .font(.caption)
      .accessibilityElement(children: .combine)
    }
  }
}

struct ClockButtons: View {
  let context: ActivityViewContext<ClockActivityAttributes>

  var body: some View {
    let onBreak = context.state.state == "break"
    HStack(spacing: 8) {
      Button(intent: ClockPunchIntent(kind: onBreak ? "Break End" : "Break Start")) {
        Label(onBreak ? context.attributes.endBreakLabel : context.attributes.startBreakLabel,
              systemImage: onBreak ? "play.fill" : "cup.and.saucer.fill")
          .frame(maxWidth: .infinity, minHeight: 32)
      }
      .buttonStyle(.bordered)
      .tint(onBreak ? Color.compassAccent : Color.orange)
      Button(intent: ClockPunchIntent(kind: "Out")) {
        Label(context.attributes.clockOutLabel, systemImage: "stop.fill")
          .frame(maxWidth: .infinity, minHeight: 32)
      }
      .buttonStyle(.borderedProminent)
      .tint(Color.red)
    }
    .font(.subheadline.weight(.semibold))
  }
}

struct ClockLockScreenView: View {
  let context: ActivityViewContext<ClockActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        ClockStatusLabel(context: context)
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
          ClockTimer(state: context.state)
            .font(.title.monospacedDigit().weight(.semibold))
            .multilineTextAlignment(.trailing)
          if context.state.state != "cue" {
            Text(context.attributes.workedLabel)
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
      }
      Text(context.attributes.projectName)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      if context.state.state != "cue" {
        NextCueRow(context: context)
        ClockButtons(context: context)
      }
    }
    .padding(16)
  }
}
