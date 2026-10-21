// Home screen and Lock Screen widgets (Section 13 Platform features: "Home screen widgets show today's shift
// and the next task"; A65-011 part 4): Today lists today's shifts across the person's orgs, Next Cue counts
// down to the next cue. Compass writes what they show as JSON into the App Group (CompassWidgetStore in
// _shared/, src/domain/glance.ts on the JS side), already in the person's language and each time on its
// project's calendar; the widgets only lay it out. They read nothing from the network.
import SwiftUI
import WidgetKit

/// The App Group payload (src/domain/glance.ts widgetPayload).
struct CompassWidgetPayload: Decodable {
  struct Shift: Decodable, Hashable {
    let id: String
    let title: String
    let time: String
    let org: String?
    let startsAt: Double
    let endsAt: Double
  }

  struct Cue: Decodable, Hashable {
    let label: String
    let at: Double
    let project: String?
  }

  let title: String
  let empty: String
  let nextCueTitle: String
  let noCue: String
  let link: String
  let shifts: [Shift]
  let cue: Cue?

  static func load() -> CompassWidgetPayload? {
    guard let data = CompassWidgetStore.read() else { return nil }
    return try? JSONDecoder().decode(CompassWidgetPayload.self, from: data)
  }
}

private func msDate(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

struct CompassWidgetEntry: TimelineEntry {
  let date: Date
  let payload: CompassWidgetPayload?

  /// Shifts not yet over at this entry's time.
  var shifts: [CompassWidgetPayload.Shift] {
    (payload?.shifts ?? []).filter { msDate($0.endsAt) > self.date }
  }

  /// The cue, until an hour after its planned time (the app replaces it once it is called).
  var cue: CompassWidgetPayload.Cue? {
    guard let cue = payload?.cue, msDate(cue.at).addingTimeInterval(3600) > self.date else { return nil }
    return cue
  }
}

struct CompassWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> CompassWidgetEntry {
    CompassWidgetEntry(date: Date(), payload: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (CompassWidgetEntry) -> Void) {
    completion(CompassWidgetEntry(date: Date(), payload: CompassWidgetPayload.load()))
  }

  /// One entry now and one at each shift end and cue, so finished items drop off without the app; the next
  /// timeline is asked for after the last boundary or in 30 minutes. The app also reloads on every change.
  func getTimeline(in context: Context, completion: @escaping (Timeline<CompassWidgetEntry>) -> Void) {
    let now = Date()
    let payload = CompassWidgetPayload.load()
    var boundaries = (payload?.shifts ?? []).map { msDate($0.endsAt) }
    if let cue = payload?.cue { boundaries.append(msDate(cue.at).addingTimeInterval(3600)) }
    let upcoming = boundaries.filter { $0 > now }.sorted().prefix(6)
    let entries = [CompassWidgetEntry(date: now, payload: payload)]
      + upcoming.map { CompassWidgetEntry(date: $0, payload: payload) }
    let refresh = min(upcoming.last ?? now.addingTimeInterval(1800), now.addingTimeInterval(1800))
    completion(Timeline(entries: entries, policy: .after(refresh)))
  }
}

struct TodayWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CompassWidgetEntry

  var body: some View {
    let limit = family == .systemSmall ? 2 : 3
    VStack(alignment: .leading, spacing: 6) {
      Text(entry.payload?.title ?? "Compass")
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color.compassAccent)
      if entry.shifts.isEmpty {
        Text(entry.payload?.empty ?? "")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      ForEach(entry.shifts.prefix(limit), id: \.self) { shift in
        VStack(alignment: .leading, spacing: 1) {
          Text(shift.title)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
          Text(shift.time)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
          if let org = shift.org {
            Text(org)
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        .accessibilityElement(children: .combine)
      }
      Spacer(minLength: 0)
      if family != .systemSmall, let cue = entry.cue {
        HStack(spacing: 4) {
          Image(systemName: "music.mic")
          Text(entry.payload?.nextCueTitle ?? "")
            .foregroundStyle(.secondary)
          Text(cue.label).fontWeight(.semibold).lineLimit(1)
          Spacer()
          Text(msDate(cue.at), style: .time)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .containerBackground(.fill.tertiary, for: .widget)
    .widgetURL(URL(string: entry.payload?.link ?? ""))
  }
}

struct NextCueWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CompassWidgetEntry

  var body: some View {
    Group {
      if family == .accessoryInline {
        if let cue = entry.cue {
          Text("\(cue.label) \(msDate(cue.at), style: .time)")
        } else {
          Text(entry.payload?.noCue ?? "")
        }
      } else {
        VStack(alignment: .leading, spacing: 2) {
          Label(entry.payload?.nextCueTitle ?? "", systemImage: "music.mic")
            .font(.caption)
            .foregroundStyle(family == .accessoryRectangular ? .primary : Color.compassAccent)
          if let cue = entry.cue {
            Text(cue.label)
              .font(family == .accessoryRectangular ? .headline : .title3.weight(.semibold))
              .lineLimit(2)
              .minimumScaleFactor(0.75)
            if msDate(cue.at) > entry.date {
              Text(timerInterval: entry.date...msDate(cue.at), countsDown: true)
                .font(.caption.monospacedDigit())
            } else {
              Text(msDate(cue.at), style: .time)
                .font(.caption)
            }
            if family != .accessoryRectangular, let project = cue.project {
              Text(project)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          } else {
            Text(entry.payload?.noCue ?? "")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
    .widgetURL(URL(string: entry.payload?.link ?? ""))
  }
}

struct TodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CompassToday", provider: CompassWidgetProvider()) { entry in
      TodayWidgetView(entry: entry)
    }
    .configurationDisplayName("Compass Today")
    .description("Your shifts today and the next cue.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct NextCueWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CompassNextCue", provider: CompassWidgetProvider()) { entry in
      NextCueWidgetView(entry: entry)
    }
    .configurationDisplayName("Compass Next Cue")
    .description("The time to the next cue.")
    .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryInline])
  }
}
