// The app side of the clock Live Activity (SIM-005, journey 52): start it at clock in, update it on a break,
// end it at clock out, and hand the JS side the punches queued from the lock screen or the Dynamic Island.
import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

struct ClockLabelsRecord: Record {
  @Field var projectName: String = ""
  @Field var onShift: String = ""
  @Field var onBreak: String = ""
  @Field var since: String = ""
  @Field var worked: String = ""
  @Field var startBreak: String = ""
  @Field var endBreak: String = ""
  @Field var clockOut: String = ""
  @Field var nextCue: String = ""
}

struct ClockContentRecord: Record {
  @Field var state: String = "on"
  @Field var onShiftSince: Double = 0
  @Field var segmentStart: Double = 0
  @Field var workedBaseSeconds: Double = 0
  @Field var breakSince: Double? = nil
  @Field var nextCueLabel: String? = nil
  @Field var nextCueAt: Double? = nil
}

private func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

@available(iOS 16.2, *)
private func contentState(_ r: ClockContentRecord) -> ClockActivityAttributes.ContentState {
  ClockActivityAttributes.ContentState(
    state: r.state,
    onShiftSince: date(r.onShiftSince),
    segmentStart: date(r.segmentStart),
    workedBaseSeconds: r.workedBaseSeconds,
    breakSince: r.breakSince.map(date),
    nextCueLabel: r.nextCueLabel,
    nextCueAt: r.nextCueAt.map(date))
}

public class CompassLiveActivityModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("CompassLiveActivity")

    Events("onPunchQueued")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: ClockPunchQueue.queued, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onPunchQueued", [:])
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    /// True when this device shows Live Activities and the person allows them for Compass.
    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    /// Starts the activity, or updates the running one, and stores the punch context the intent copies.
    AsyncFunction("start") { (labels: ClockLabelsRecord, content: ClockContentRecord, context: String) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      ClockPunchQueue.defaults?.set(context, forKey: ClockPunchQueue.contextKey)
      let state = contentState(content)
      if let running = Activity<ClockActivityAttributes>.activities.first {
        await running.update(ActivityContent(state: state, staleDate: nil))
        return running.id
      }
      let attributes = ClockActivityAttributes(
        projectName: labels.projectName,
        onShiftLabel: labels.onShift,
        onBreakLabel: labels.onBreak,
        sinceLabel: labels.since,
        workedLabel: labels.worked,
        startBreakLabel: labels.startBreak,
        endBreakLabel: labels.endBreak,
        clockOutLabel: labels.clockOut,
        nextCueTitle: labels.nextCue.isEmpty ? nil : labels.nextCue)
      let activity = try Activity.request(
        attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
      return activity.id
    }

    AsyncFunction("update") { (content: ClockContentRecord) in
      guard #available(iOS 16.2, *) else { return }
      let state = contentState(content)
      for activity in Activity<ClockActivityAttributes>.activities {
        await activity.update(ActivityContent(state: state, staleDate: nil))
      }
    }

    AsyncFunction("end") { () in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<ClockActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      ClockPunchQueue.defaults?.removeObject(forKey: ClockPunchQueue.contextKey)
    }

    /// Stores what the Clock In App Shortcut needs for the next clock in (ClockInIntent.swift reads it as
    /// ClockInPrepared): the punch context, the activity labels and the replies, as JSON. Empty clears it.
    Function("prepareClockIn") { (json: String) in
      if json.isEmpty {
        ClockPunchQueue.defaults?.removeObject(forKey: "compass.clock.next")
      } else {
        ClockPunchQueue.defaults?.set(Data(json.utf8), forKey: "compass.clock.next")
      }
    }

    /// The punches queued from the lock screen, oldest first. They stay queued until acknowledged.
    Function("peekQueue") { () -> [[String: Any]] in
      ClockPunchQueue.peek()
    }

    Function("ackQueue") { (ids: [String]) in
      ClockPunchQueue.ack(ids)
    }

    /// Writes what the home screen widgets show (JSON, CompassWidgets.swift reads it) into the App Group
    /// and asks WidgetKit to redraw them. Empty clears it, at sign-out.
    Function("setWidgetData") { (json: String) in
      CompassWidgetStore.write(json)
      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
      }
    }
  }
}
