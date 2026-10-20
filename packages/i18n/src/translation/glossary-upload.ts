/**
 * Uploads translation/glossary.csv to Google as an equivalent term set glossary (owner-run).
 * The resource id carries the glossary version (xos-glossary-<hash>), so a run never overwrites a
 * glossary a translation could be using: an unchanged file is a no-op, and a changed file creates a
 * new glossary. Google reads the file from Cloud Storage, so it is copied to
 * gs://<GOOGLE_TRANSLATE_GLOSSARY_BUCKET>/glossaries/<id>.csv first.
 */
import { GoogleError, TRANSLATE_HOST, googleFetch, type GoogleOptions } from "./transport.ts";

export interface UploadOptions extends Pick<
  GoogleOptions,
  "project" | "location" | "token" | "fetch" | "sleep"
> {
  readonly bucket: string;
  readonly glossaryId: string;
  readonly csv: string;
  readonly languages: readonly string[];
  /** Delete older glossaries whose id starts with this prefix. */
  readonly prunePrefix?: string;
  readonly log: (line: string) => void;
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
}

export async function uploadGlossary(o: UploadOptions): Promise<"exists" | "created"> {
  const parent = `projects/${o.project}/locations/${o.location}`;
  const name = `${parent}/glossaries/${o.glossaryId}`;
  let exists = true;
  try {
    await googleFetch(`${TRANSLATE_HOST}/${name}`, { method: "GET" }, o);
  } catch (error) {
    if (!(error instanceof GoogleError) || error.status !== 404) throw error;
    exists = false;
  }
  if (exists) {
    o.log(`Glossary ${o.glossaryId} already exists.`);
  } else {
    const object = `glossaries/${o.glossaryId}.csv`;
    await googleFetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(o.bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`,
      { method: "POST", body: o.csv, contentType: "text/csv; charset=utf-8" },
      o,
    );
    o.log(`Copied the glossary to gs://${o.bucket}/${object}.`);
    let op = (await googleFetch(
      `${TRANSLATE_HOST}/${parent}/glossaries`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          languageCodesSet: { languageCodes: o.languages },
          inputConfig: { gcsSource: { inputUri: `gs://${o.bucket}/${object}` } },
        }),
      },
      o,
    )) as Operation;
    const sleep = o.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let i = 0; !op.done && i < 60; i++) {
      await sleep(5000);
      op = (await googleFetch(
        `${TRANSLATE_HOST}/${op.name ?? ""}`,
        { method: "GET" },
        o,
      )) as Operation;
    }
    if (op.error)
      throw new Error(
        `Creating glossary ${o.glossaryId} failed: ${op.error.message ?? "unknown error"}`,
      );
    if (!op.done)
      throw new Error(
        `Creating glossary ${o.glossaryId} did not finish in five minutes; check ${op.name ?? "the operation"}.`,
      );
    o.log(`Created glossary ${o.glossaryId} (${o.languages.join(", ")}).`);
  }
  if (o.prunePrefix) {
    const list = (await googleFetch(
      `${TRANSLATE_HOST}/${parent}/glossaries?pageSize=1000`,
      { method: "GET" },
      o,
    )) as {
      glossaries?: Array<{ name?: string }>;
    };
    for (const g of list.glossaries ?? []) {
      const id = g.name?.split("/").pop() ?? "";
      if (id.startsWith(o.prunePrefix) && id !== o.glossaryId) {
        await googleFetch(`${TRANSLATE_HOST}/${g.name ?? ""}`, { method: "DELETE" }, o);
        o.log(`Deleted the older glossary ${id}.`);
      }
    }
  }
  return exists ? "exists" : "created";
}
