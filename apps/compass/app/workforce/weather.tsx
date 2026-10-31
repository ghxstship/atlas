import {
  getWeatherBoard,
  getWeatherFeedBoard,
  HAZARD_MEASURES,
  HAZARD_UNITS,
} from "@xos/data/workforce-site";
import { roundTo, toStoredUnit } from "@xos/i18n/units";
import i18next from "i18next";
import { WeatherScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { weatherLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";
import { useCompass } from "../../src/runtime/CompassProvider";
import { unitSystemOf } from "../../src/domain/settings";
import { useProjectCapabilities } from "../../src/domain/project-capabilities";

/**
 * Weather (Atlas site-ops.weather): alerts, thresholds and readings recorded offline. B8: the open hold and the
 * official warnings, read online, and for a dispatcher Call hold and All clear, queued so they go out when the device
 * reconnects, and refused by the server if that is more than 10 minutes later.
 */
function Weather(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const projectId = wf.projectId;
  // Values show and are typed in the person's units (locale.units), and are stored in the hazard's unit.
  const { orgSettings } = useCompass();
  const units = { locale: i18next.language, system: unitSystemOf(i18next.language, orgSettings) };
  const loaded = useLoad(projectId ? () => getWeatherBoard(wf.db, projectId) : null, [
    projectId,
    wf.syncTick,
  ]);
  const feed = useLoad(projectId ? () => getWeatherFeedBoard(wf.db, projectId) : null, [
    projectId,
    wf.syncTick,
  ]);
  const capabilities = useProjectCapabilities(projectId);
  return (
    <WeatherScreen
      {...frameProps(loaded)}
      labels={weatherLabels(t, units)}
      board={loaded.data ?? null}
      feed={feed.data ?? null}
      canDispatch={capabilities?.has("safety.incident.dispatch") === true}
      onCallHold={(message, hazard) =>
        wf.queue("call_weather_hold", {
          p_project_id: projectId,
          p_message: message,
          p_hazard: hazard ?? undefined,
        })
      }
      onAllClear={(holdId, message) =>
        wf.queue("give_weather_all_clear", { p_hold_id: holdId, p_message: message })
      }
      onRecord={(hazard, value) =>
        wf.queue("record_weather_reading", {
          p_project_id: projectId,
          p_hazard: hazard,
          p_value: roundTo(
            toStoredUnit(value, HAZARD_MEASURES[HAZARD_UNITS[hazard].unit], units.system),
            2,
          ),
          p_observed_at: new Date().toISOString(),
        })
      }
    />
  );
}

export default function WeatherRoute(): ReactElement {
  return (
    <WorkforceGate needsProject>
      <Weather />
    </WorkforceGate>
  );
}
