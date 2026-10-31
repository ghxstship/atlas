import { expect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { DEMO_ORG_ID, localSql, OWNER, PRODUCER_EMAIL, projectId } from "./b8-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B8 (RRR-232, gap G-150): the Weather page's official feed and the hold. An official Severe warning and the next
 * hours of the forecast are stored for the NWS project as the feed would store them (no request leaves the machine);
 * the page shows them, marked as issued by the National Weather Service in English. With the Severe warning active,
 * Call hold leads; the dispatcher sends the prefilled hold after one confirm, the hold banner shows, and the all-clear
 * closes it.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test.describe("The official weather feed and the hold (B8)", () => {
  test("shows warnings and the forecast, calls a hold and gives the all-clear", async ({
    page,
  }) => {
    const id = uniqueId().slice(-6).toUpperCase();
    const project = await projectId();
    const alertId = `urn:oid:2.49.0.1.840.0.b8-${id}`;
    await localSql(
      `insert into app.weather_warnings (org_id, project_id, provider_alert_id, event, severity, headline, description, sent_at, ends_at)
       values ($1, $2, $3, 'Severe Thunderstorm Warning', 'Severe', $4, 'At 9:02 PM, a severe thunderstorm was located over the venue.',
         now(), now() + interval '2 hours')`,
      [DEMO_ORG_ID, project, alertId, `Severe Thunderstorm Warning ${id}`],
    );
    await localSql(
      `insert into app.weather_forecast_periods (org_id, project_id, starts_at, ends_at, temperature_f, wind_speed_mph, precipitation_percent, short_forecast)
       select $1, $2, date_trunc('hour', now()) + n * interval '1 hour', date_trunc('hour', now()) + (n + 1) * interval '1 hour',
         84, 12, 40, 'Chance Showers'
       from generate_series(0, 2) n`,
      [DEMO_ORG_ID, project],
    );
    try {
      await signInAs(page, PRODUCER_EMAIL, DEMO_ORG);
      await page.goto(`/${DEMO_ORG}/site-ops/weather?project=${project}`);
      await settle(page);
      const feed = page.getByRole("region", { name: "Official feed" });
      await expect(feed).toContainText(`Severe Thunderstorm Warning ${id}`);
      await expect(feed).toContainText("Issued by the National Weather Service, in English");
      await expect(feed.getByRole("grid", { name: "Next 12 hours" })).toContainText(
        "Chance Showers",
      );
      await expectAccessible(page);

      await page.getByRole("button", { name: "Call hold" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Message")).not.toHaveValue("");
      await dialog.getByRole("button", { name: "Call hold" }).click();
      await expect(page.getByText(/^Weather hold since/)).toBeVisible();

      await page.getByRole("button", { name: "All clear" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "All clear" }).click();
      await expect(page.getByText(/^Weather hold since/)).toHaveCount(0);
    } finally {
      for (const [text, args] of [
        [
          `update app.weather_holds set cleared_at = now(), cleared_by = $2, all_clear_message = 'Journey cleanup.'
            where project_id = $1 and cleared_at is null`,
          [project, OWNER],
        ],
        [
          "update app.weather_warnings set ended_at = now() where provider_alert_id = $1",
          [alertId],
        ],
        ["delete from app.weather_forecast_periods where project_id = $1", [project]],
      ] as const) {
        await localSql(text, [...args]).catch((error: unknown) =>
          console.warn("B8 journey cleanup", error),
        );
      }
    }
  });
});
