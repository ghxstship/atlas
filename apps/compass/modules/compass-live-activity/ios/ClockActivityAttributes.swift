// The clock Live Activity's data for the native module (SIM-005). The same declarations are linked into the
// app and the widget extension from targets/ClockActivity/_shared/ClockActivityAttributes.swift;
// test/live-activity.test.ts keeps the two copies identical, because ActivityKit matches an activity to its
// widget by the attributes' type name and Codable shape.
// BEGIN SHARED DECLARATIONS
import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct ClockActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// "on" while working, "break" during a break.
    var state: String
    /// When the open entry began (clock in).
    var onShiftSince: Date
    /// While working, the timer counts up from this date and reads worked time.
    var segmentStart: Date
    /// Worked seconds frozen at the start of the running break.
    var workedBaseSeconds: Double
    /// When the running break began.
    var breakSince: Date?
  }

  /// The project the shift is on.
  var projectName: String
  /// Copy from the app's catalog, so the widget speaks the person's language.
  var onShiftLabel: String
  var onBreakLabel: String
  var sinceLabel: String
  var workedLabel: String
  var startBreakLabel: String
  var endBreakLabel: String
  var clockOutLabel: String
}

/// Punches made on the lock screen or in the Dynamic Island, queued in the App Group for the app to drain
/// into its sync outbox, and the punch context the app stored when it started the activity.
enum ClockPunchQueue {
  static let appGroup = "group.pro.ghxstship.compass"
  static let queueKey = "compass.clock.queue"
  static let contextKey = "compass.clock.context"
  static let queued = Notification.Name("CompassClockPunchQueued")

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  static func append(kind: String, at date: Date) {
    guard let defaults else { return }
    var items = defaults.array(forKey: queueKey) as? [[String: Any]] ?? []
    items.append([
      "id": uuidv7(date),
      "kind": kind,
      "at": (date.timeIntervalSince1970 * 1000).rounded(),
      "context": defaults.string(forKey: contextKey) ?? "",
    ])
    defaults.set(items, forKey: queueKey)
  }

  static func peek() -> [[String: Any]] {
    defaults?.array(forKey: queueKey) as? [[String: Any]] ?? []
  }

  static func ack(_ ids: [String]) {
    guard let defaults else { return }
    let done = Set(ids)
    let items = (defaults.array(forKey: queueKey) as? [[String: Any]] ?? [])
      .filter { !done.contains($0["id"] as? String ?? "") }
    defaults.set(items, forKey: queueKey)
  }

  /// A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits with the version and variant set.
  static func uuidv7(_ date: Date) -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    let ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
    for i in 0..<6 { bytes[i] = UInt8((ms >> (8 * UInt64(5 - i))) & 0xff) }
    for i in 6..<16 { bytes[i] = UInt8.random(in: 0...255) }
    bytes[6] = (bytes[6] & 0x0f) | 0x70
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let parts = [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4), hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
    return parts.map(String.init).joined(separator: "-")
  }
}
// END SHARED DECLARATIONS
