import { atlasAs, ORG } from "./atlas";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import {
  DEMO,
  expectAccessible,
  expectAccessibleInBothThemes,
  signIn,
  sql,
  uniqueId,
} from "./support";

/**
 * P5 (RRR-219, G-144) across Atlas and Gateway: the org asks the crew person for a badge photo; the request
 * reaches their updates and opens Profile, Badge photos; they upload a photo they crop themselves, which the org
 * sees as Provided once the local pass-through scan marks it Clean, and which prints on the badge; then they remove
 * it, which withdraws their consent and deletes the photo, and the org's badge prints without it.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** A 30 by 40 PNG portrait the crew person picks from their device. */
function portrait(): Buffer {
  // A tiny valid PNG; the page crops it onto a 3 by 4 canvas and saves a JPEG.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
}

/** A live credential for the crew person on the demo project, under a fresh category; earlier runs' photos go. */
async function seedCrewCredential(): Promise<string> {
  const id = uniqueId().slice(-6).toUpperCase();
  await sql(
    `update app.credential_photos set deleted_at = now()
      where org_id = $1 and person_id = $2 and deleted_at is null`,
    [DEMO.org, DEMO.crew],
  );
  await sql(
    `update app.consent_records set withdrawn_at = now()
      where org_id = $1 and person_id = $2 and purpose_code = 'credential_photo' and withdrawn_at is null`,
    [DEMO.org, DEMO.crew],
  );
  const [row] = await sql<{ id: string }>(
    `with c as (insert into app.credential_categories (project_id, code, name) values ($1, $2, $3) returning id)
     insert into app.credentials (credential_category_id, holder_person_id, valid_to)
     select c.id, $4, now() + interval '7 days' from c returning id`,
    [DEMO.project, `P5G-${id}`, `Photo run ${id}`, DEMO.crew],
  );
  if (!row) throw new Error("no credential seeded");
  return row.id;
}

/** Stands in for the upload-scan worker's local pass-through (ADR 0034): the crew person's new photos scan Clean. */
async function passPhotoScans(): Promise<number> {
  const rows = await sql<{ status: string }>(
    `select app.record_object_scan(s.id, true)::text as status
       from private.object_scans s
      where s.bucket_id = 'credential-photos' and s.scan_status = 'Scanning'
        and s.object_name like $1`,
    [`${DEMO.org}/${DEMO.crew}/%`],
  );
  return rows.length;
}

async function photoCard(page: Page) {
  // The org's card is the innermost section that names it; the page's own regions come before it.
  return page
    .locator("section")
    .filter({ has: page.getByText("Demo Productions", { exact: true }) })
    .last();
}

test("the org asks for a badge photo, the holder gives it, it prints, and the holder takes it back", async ({
  page,
  browser,
}) => {
  const credential = await seedCrewCredential();
  const record = `/${ORG}/credentials/issued?project=NWS&peek=${credential}`;

  // Atlas: the producer asks the holder for a photo.
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(record);
  const atlasPhoto = atlas.page.getByRole("dialog").getByRole("region", { name: "Badge photo" });
  await atlasPhoto.getByRole("button", { name: "Request photo" }).click();
  await expect(atlasPhoto.getByRole("status")).toHaveText("1 holder asked.");

  // Gateway: the request is among the holder's updates and opens Badge photos.
  await signIn(page, "crew@example.com");
  await page
    .getByRole("link", { name: "Demo Productions asks for your badge photo" })
    .first()
    .click();
  await page.waitForURL((url) => url.pathname === "/profile/badge-photos");
  await expect(page.getByRole("heading", { level: 1, name: "Badge photos" })).toBeVisible();
  const card = await photoCard(page);
  await expect(card.getByText("Requested", { exact: true })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The holder picks a photo, keeps the crop and saves it.
  await card.getByLabel("Upload or take photo").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: portrait(),
  });
  await expect(card.getByRole("img", { name: "Crop the photo" })).toBeVisible();
  await card.getByRole("button", { name: "Save photo" }).click();
  await expect(card.getByRole("status")).toHaveText(
    "Photo saved. It prints once it is checked, in a few minutes.",
  );
  const [stored] = await sql<{ source: string; purpose: string; withdrawn: boolean }>(
    `select p.source::text as source, r.purpose_code as purpose, r.withdrawn_at is not null as withdrawn
       from app.credential_photos p join app.consent_records r on r.id = p.consent_record_id
      where p.org_id = $1 and p.person_id = $2 and p.deleted_at is null`,
    [DEMO.org, DEMO.crew],
  );
  expect(stored).toEqual({
    source: "Holder Upload",
    purpose: "credential_photo",
    withdrawn: false,
  });

  expect(await passPhotoScans()).toBeGreaterThan(0);
  await page.reload();
  await settle(page);
  await expect((await photoCard(page)).getByText("On your badge", { exact: true })).toBeVisible();
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAccessible(page);
  if (size) await page.setViewportSize(size);

  // Atlas: the org sees the photo, and the CR80 badge prints it.
  await atlas.page.goto(record);
  const provided = atlas.page.getByRole("dialog").getByRole("region", { name: "Badge photo" });
  await expect(provided.getByText("Provided", { exact: true })).toBeVisible();
  const pdf = await atlas.page.request.get(
    `/${ORG}/documents/credential-badge/${credential}?paper=cr80`,
  );
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).toString("latin1")).toContain(
    "/Alt (Photo of Demo Crew Member, the credential holder)",
  );

  // Gateway: the holder removes it; the consent is withdrawn and the photo deleted.
  await (await photoCard(page)).getByRole("button", { name: "Remove" }).click();
  await expect(
    (await photoCard(page)).getByText("Photo removed and your consent withdrawn."),
  ).toBeVisible();
  const [after] = await sql<{ live: number; withdrawn: boolean; objects: number }>(
    `select
       (select count(*)::int from app.credential_photos where org_id = $1 and person_id = $2 and deleted_at is null) as live,
       (select bool_and(withdrawn_at is not null) from app.consent_records
         where org_id = $1 and person_id = $2 and purpose_code = 'credential_photo') as withdrawn,
       (select count(*)::int from storage.objects where bucket_id = 'credential-photos' and name like $3) as objects`,
    [DEMO.org, DEMO.crew, `${DEMO.org}/${DEMO.crew}/%`],
  );
  expect(after).toEqual({ live: 0, withdrawn: true, objects: 0 });

  // Atlas: the badge prints without it.
  await atlas.page.goto(record);
  const missing = atlas.page.getByRole("dialog").getByRole("region", { name: "Badge photo" });
  await expect(missing.getByText(/^(Missing|Profile photo)$/)).toBeVisible();
  await atlas.context.close();
});
