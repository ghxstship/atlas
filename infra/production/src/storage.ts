/**
 * Storage objects of the demo orgs (RRR-109). SQL cannot delete rows of storage.objects (the
 * storage.protect_objects_delete trigger refuses it), so the removal wrapper lists the objects with the
 * dry run (a CSV of bucket and object name) and deletes them through the Storage API with the service role:
 * DELETE /storage/v1/object/{bucket} with a JSON body {"prefixes": [names]}, at most 100 names a request.
 */

export interface StorageObject {
  bucket: string;
  name: string;
}

export const BATCH_SIZE = 100;

/** Parses the dry run's CSV (bucket_id,name; names may be quoted with doubled quotes). */
export function parseObjectList(csv: string): StorageObject[] {
  const objects: StorageObject[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        fields.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field);
    if (fields.length !== 2 || !fields[0] || !fields[1])
      throw new Error(`Malformed storage list line: ${line}`);
    objects.push({ bucket: fields[0], name: fields[1] });
  }
  return objects;
}

/** Groups objects by bucket into requests of at most BATCH_SIZE names. */
export function batchByBucket(
  objects: readonly StorageObject[],
  size = BATCH_SIZE,
): StorageObject[][] {
  const byBucket = new Map<string, StorageObject[]>();
  for (const object of objects) {
    const list = byBucket.get(object.bucket) ?? [];
    list.push(object);
    byBucket.set(object.bucket, list);
  }
  const batches: StorageObject[][] = [];
  for (const bucket of [...byBucket.keys()].sort()) {
    const list = byBucket.get(bucket) ?? [];
    for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  }
  return batches;
}

export interface DeleteResult {
  requested: number;
  deleted: number;
}

/** Deletes the objects through the Storage API; throws on the first failed request. */
export async function deleteObjects(
  objects: readonly StorageObject[],
  options: { url: string; serviceKey: string; fetch?: typeof fetch },
): Promise<DeleteResult> {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  let deleted = 0;
  for (const batch of batchByBucket(objects)) {
    const bucket = batch[0]?.bucket ?? "";
    const response = await doFetch(`${base}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE",
      headers: {
        apikey: options.serviceKey,
        authorization: `Bearer ${options.serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefixes: batch.map((object) => object.name) }),
    });
    if (!response.ok) {
      throw new Error(
        `Storage API refused deleting ${batch.length} objects in ${bucket}: HTTP ${response.status}`,
      );
    }
    const removed = (await response.json()) as unknown;
    deleted += Array.isArray(removed) ? removed.length : 0;
  }
  return { requested: objects.length, deleted };
}
