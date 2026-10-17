// The lock screen and Dynamic Island punch buttons (SIM-005, journey 52). Linked into the app and the widget
// extension: as a LiveActivityIntent it runs in the app's process, launched in the background if needed, so
// Compass never comes to the front. It queues the punch in the App Group for the app's sync outbox (the same
// app.record_punch an in-app punch sends) and moves the activity to its new state at once.
import ActivityKit
import AppIntents
import Foundation

@available(iOS 17.0, *)
struct ClockPunchIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Compass clock punch"
  static var isDiscoverable: Bool = false

  /// "Break Start", "Break End" or "Out", as app.punch_kind spells them.
  @Parameter(title: "Punch")
  var kind: String

  init() {}

  init(kind: String) {
    self.kind = kind
  }

  func perform() async throws -> some IntentResult {
    let now = Date()
    ClockPunchQueue.append(kind: kind, at: now)
    for activity in Activity<ClockActivityAttributes>.activities {
      var state = activity.content.state
      switch kind {
      case "Break Start":
        guard state.state == "on" else { continue }
        state.workedBaseSeconds = max(0, now.timeIntervalSince(state.segmentStart))
        state.state = "break"
        state.breakSince = now
      case "Break End":
        guard state.state == "break" else { continue }
        state.segmentStart = now.addingTimeInterval(-state.workedBaseSeconds)
        state.workedBaseSeconds = 0
        state.state = "on"
        state.breakSince = nil
      case "Out":
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate)
        continue
      default:
        continue
      }
      await activity.update(ActivityContent(state: state, staleDate: nil))
    }
    NotificationCenter.default.post(name: ClockPunchQueue.queued, object: nil)
    return .result()
  }
}
