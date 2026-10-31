import pg from "pg";

/**
 * Shared set-up for the B8 journeys (RRR-232): SQL on the local stack only, as postgres, under a person's claims where
 * an RPC or a policy needs one. The demo tenant comes from the seeds (0010 people, 0107 the NWS project, 0114 the
 * Bayside Festival Grounds zones LAWN and VIP).
 */

export const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
export const OWNER = "01920000-0000-7000-8000-000000000101";
export const PRODUCER_EMAIL = "producer@example.com";
export const PROJECT_KEY = "NWS";

/** One statement as postgres against the local stack only, under `person`'s claims when given. */
export async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
  person?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The B8 journeys change data only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    if (person) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: person, role: "authenticated" }),
      ]);
    }
    const result = await client.query(text, args);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

/** The NWS project's id. */
export async function projectId(): Promise<string> {
  const [row] = await localSql<{ id: string }>(
    "select id from app.projects where org_id = $1 and project_key = $2 and deleted_at is null",
    [DEMO_ORG_ID, PROJECT_KEY],
  );
  if (!row) throw new Error("The demo org has no NWS project.");
  return row.id;
}

/** A person of the demo org by display name, such as Demo Field Lead. */
export async function personNamed(name: string): Promise<string> {
  const [row] = await localSql<{ id: string }>(
    `select p.id from app.people p join app.memberships m on m.person_id = p.id
      where m.org_id = $1 and m.deleted_at is null and p.full_name = $2 limit 1`,
    [DEMO_ORG_ID, name],
  );
  if (!row) throw new Error(`The demo org has no ${name}.`);
  return row.id;
}

/** A credential category of the NWS project with a code unique to the run, created as the Owner. */
export async function newCategory(
  code: string,
  name: string,
  kind: "Access" | "Parking" = "Access",
): Promise<string> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.credential_categories (project_id, code, name, category_kind)
     values ($1, $2, $3, $4) returning id`,
    [await projectId(), code, name, kind],
    OWNER,
  );
  return row?.id as string;
}

/** Access for a category to a zone of the Bayside Festival Grounds by code, open from yesterday to tomorrow. */
export async function grantZone(categoryId: string, zoneCode: "LAWN" | "VIP"): Promise<void> {
  await localSql(
    `insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
     values ($1, (select z.id from app.zones z where z.org_id = $2 and z.code = $3 and z.deleted_at is null limit 1),
       (select e.record_id from xpms.std_enumeration e where e.enum_domain = 'Access Level' order by e.sort_order limit 1),
       now() - interval '1 day', now() + interval '1 day')`,
    [categoryId, DEMO_ORG_ID, zoneCode],
    OWNER,
  );
}

/** Issues a category to a person as the Owner; returns the printed number. */
export async function issue(
  categoryId: string,
  holder: string,
): Promise<{ id: string; number: string }> {
  const [row] = await localSql<{ id: string; credential_number: string }>(
    `insert into app.credentials (credential_category_id, holder_person_id) values ($1, $2)
     returning id, credential_number`,
    [categoryId, holder],
    OWNER,
  );
  return { id: row?.id as string, number: row?.credential_number as string };
}

/** Revokes what a journey issued and archives its categories, so a rerun starts clean. Best effort. */
export async function removeCategories(ids: readonly string[]): Promise<void> {
  for (const [text, person] of [
    [
      "update app.credentials set revoked_at = now() where credential_category_id = any ($1) and revoked_at is null",
      OWNER,
    ],
    [
      "update app.credential_categories set deleted_at = now() where id = any ($1) and deleted_at is null",
      undefined,
    ],
  ] as const) {
    try {
      await localSql(text, [[...ids]], person);
    } catch (error) {
      console.warn("B8 journey cleanup", error);
    }
  }
}
