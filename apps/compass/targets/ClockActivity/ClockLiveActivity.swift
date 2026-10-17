// The clock Live Activity on the Lock Screen and in the Dynamic Island (SIM-005, journey 52; Section 11.13
// Clock). Shows on shift since, the break, and the worked time, with Break and Clock Out buttons that run
// ClockPunchIntent without opening Compass. expo-target.config.json declares this extension; @bacons/apple-targets
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
          ClockButtons(context: context)
        }
      } compactLeading: {
        Image(systemName: context.state.state == "break" ? "cup.and.saucer.fill" : "clock.fill")
          .foregroundStyle(Color.compassAccent)
      } compactTrailing: {
        ClockTimer(state: context.state)
          .font(.caption.monospacedDigit())
          .frame(maxWidth: 56)
      } minimal: {
        Image(systemName: context.state.state == "break" ? "cup.and.saucer.fill" : "clock.fill")
          .foregroundStyle(Color.compassAccent)
      }
      .keylineTint(Color.compassAccent)
    }
  }
}

/// Worked time: a running timer while working, frozen during a break.
struct ClockTimer: View {
  let state: ClockActivityAttributes.ContentState

  var body: some View {
    if state.state == "break" {
      Text(Duration.seconds(state.workedBaseSeconds).formatted(.time(pattern: .hourMinuteSecond)))
    } else {
      Text(timerInterval: state.segmentStart...Date.distantFuture, countsDown: false)
    }
  }
}

struct ClockStatusLabel: View {
  let context: ActivityViewContext<ClockActivityAttributes>

  var body: some View {
    let onBreak = context.state.state == "break"
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
          Text(context.attributes.workedLabel)
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      Text(context.attributes.projectName)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      ClockButtons(context: context)
    }
    .padding(16)
  }
}
