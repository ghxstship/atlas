import { getWeatherBoard } from "@xos/data/workforce-site";
import { WeatherScreen } from "@xos/workforce-native";
import type { ReactElement } from "react";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { weatherLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Weather (Atlas site-ops.weather): alerts, thresholds and readings recorded offline. */
function Weather(): ReactElement {
  const t = useT();
  const wf = useWorkforce(t);
  const projectId = wf.projectId;
  const loaded = useLoad(projectId ? () => getWeatherBoard(wf.db, projectId) : null, [
    projectId,
    wf.syncTick,
  ]);
  return (
    <WeatherScreen
      {...frameProps(loaded)}
      labels={weatherLabels(t)}
      board={loaded.data ?? null}
      onRecord={(hazard, value) =>
        wf.queue("record_weather_reading", {
          p_project_id: projectId,
          p_hazard: hazard,
          p_value: value,
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
