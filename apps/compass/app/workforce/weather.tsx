import { getWeatherBoard, HAZARD_MEASURES, HAZARD_UNITS } from "@xos/data/workforce-site";
import { roundTo, toStoredUnit } from "@xos/i18n/units";
import i18next from "i18next";
import { WeatherScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { weatherLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";
import { useCompass } from "../../src/runtime/CompassProvider";
import { unitSystemOf } from "../../src/domain/settings";

/** Weather (Atlas site-ops.weather): alerts, thresholds and readings recorded offline. */
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
  return (
    <WeatherScreen
      {...frameProps(loaded)}
      labels={weatherLabels(t, units)}
      board={loaded.data ?? null}
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
