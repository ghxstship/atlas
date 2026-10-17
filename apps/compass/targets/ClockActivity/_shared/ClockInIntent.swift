// The Clock In App Shortcut (Section 11.13 Clock: "An App Shortcut supports Siri, the iPhone Action Button";
// journey 52's clock-in step). Linked into the app and the widget extension like ClockPunchIntent. As a
// LiveActivityIntent it runs in the app's process without bringing Compass to the front: it queues an "In"
// punch in the same App Group queue the lock screen buttons use (the app drains it into its sync outbox as
// app.record_punch, keyed by the punch id minted here) and starts the clock Live Activity, so Break and Clock
// Out are one tap away on the lock screen. The punch context, the activity labels and the replies come from
// the app, which stores them whenever Today knows where the person clocks in next.
import ActivityKit
import AppIntents
import Foundation

/// What the app prepared for the next clock in: the punch context, the activity's labels and the replies,
/// already in the person's language.
struct ClockInPrepared: Codable {
  struct Labels: Codable {
    var projectName: String
    var onShift: String
    var onBreak: String
    var since: String
    var worked: String
    var startBreak: String
    var endBreak: String
    var clockOut: String
  }

  var context: String
  var labels: Labels
  var clockedIn: String
  var alreadyIn: String

  static let key = "compass.clock.next"

  static func load() -> ClockInPrepared? {
    guard let data = ClockPunchQueue.defaults?.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(ClockInPrepared.self, from: data)
  }
}

@available(iOS 17.0, *)
struct ClockInIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Clock In"
  static var description = IntentDescription("Clock in to your shift in Compass without opening the app.")
  static var openAppWhenRun: Bool = false

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let prepared = ClockInPrepared.load(), !prepared.context.isEmpty else {
      // Nothing prepared yet: the app has not opened Today since sign-in, so it cannot know the shift.
      return .result(dialog: IntentDialog(stringLiteral: "Open Compass once so it knows where you clock in."))
    }
    if !Activity<ClockActivityAttributes>.activities.isEmpty {
      return .result(dialog: IntentDialog(stringLiteral: prepared.alreadyIn))
    }
    let now = Date()
    // The queue copies the stored context into the punch; Break and Clock Out reuse it from the lock screen.
    ClockPunchQueue.defaults?.set(prepared.context, forKey: ClockPunchQueue.contextKey)
    ClockPunchQueue.append(kind: "In", at: now)
    let labels = prepared.labels
    let attributes = ClockActivityAttributes(
      projectName: labels.projectName,
      onShiftLabel: labels.onShift,
      onBreakLabel: labels.onBreak,
      sinceLabel: labels.since,
      workedLabel: labels.worked,
      startBreakLabel: labels.startBreak,
      endBreakLabel: labels.endBreak,
      clockOutLabel: labels.clockOut)
    let state = ClockActivityAttributes.ContentState(
      state: "on", onShiftSince: now, segmentStart: now, workedBaseSeconds: 0, breakSince: nil)
    // The punch is queued either way; the in-app card stays the clock if the activity cannot start.
    _ = try? Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
    NotificationCenter.default.post(name: ClockPunchQueue.queued, object: nil)
    return .result(dialog: IntentDialog(stringLiteral: prepared.clockedIn))
  }
}

// The app offers the shortcut. The widget extension compiles this file too; its copy is never registered, because
// Shortcuts and Siri read App Shortcuts from the app bundle.
@available(iOS 17.0, *)
struct CompassShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ClockInIntent(),
      phrases: [
        "Clock in with \(.applicationName)",
        "Start my shift in \(.applicationName)",
      ],
      shortTitle: "Clock In",
      systemImageName: "clock.badge.checkmark")
  }
}
