import { createHash, createHmac } from "node:crypto";
import { IntegrationError } from "../framework/errors.ts";
import type { HttpClient } from "../framework/http.ts";
import type { WarehouseObject, WarehouseProvider, WarehouseTarget } from "./provider.ts";

/**
 * S3 and S3-compatible object storage (A83, finding A65-029): PutObject signed with AWS Signature Version 4,
 * written by hand so the Edge bundle needs no SDK. AWS buckets use virtual-hosted URLs
 * (https://<bucket>.s3.<region>.amazonaws.com/<key>); any other S3-compatible service (Cloudflare R2, MinIO,
 * Wasabi, Backblaze B2, Google Cloud Storage interoperability) uses its own HTTPS endpoint with path-style
 * URLs. The credential is the JSON the destination stored in Vault:
 * {"access_key_id": "...", "secret_access_key": "...", "session_token": "..." (optional)}.
 * Every request names the SHA-256 of its body, so a corrupted upload is refused by the service.
 */

export interface S3Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | null;
}

/** Reads the stored credential; anything malformed is a permanent, credential-level failure. */
export function parseS3Credential(secret: string): S3Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    parsed = null; // Reported below as a malformed credential.
  }
  const fields = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const accessKeyId = fields["access_key_id"];
  const secretAccessKey = fields["secret_access_key"];
  const sessionToken = fields["session_token"];
  if (
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string" ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new IntegrationError(
      "warehouse_credential_malformed",
      "The bucket credential must be JSON with access_key_id and secret_access_key.",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: typeof sessionToken === "string" && sessionToken ? sessionToken : null,
  };
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of each path segment, as SigV4 canonical URIs require. */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** The URL of an object: virtual-hosted on AWS, path-style on any other endpoint. */
export function objectUrl(target: WarehouseTarget, key: string): URL {
  const region = target.region ?? "us-east-1";
  if (target.endpointUrl === null) {
    return new URL(`https://${target.bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`);
  }
  const base = target.endpointUrl.replace(/\/+$/, "");
  return new URL(`${base}/${encodeURIComponent(target.bucket)}/${encodeKey(key)}`);
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** Signs a PUT of `body` to `key` (AWS Signature Version 4, service s3, unsigned query). */
export function signPut(
  target: WarehouseTarget,
  credential: S3Credential,
  key: string,
  body: Uint8Array,
  contentType: string,
  now: Date,
): SignedRequest {
  const url = objectUrl(target, key);
  const region = target.region ?? "us-east-1";
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    "content-type": contentType,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credential.sessionToken !== null) headers["x-amz-security-token"] = credential.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [
    "PUT",
    url.pathname,
    "",
    ...names.map((n) => `${n}:${String(headers[n]).trim()}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credential.secretAccessKey}`, day), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers["host"];
  return { url: url.toString(), headers };
}

/** Turns an S3 error response into a delivery failure: access and bucket errors are permanent. */
export function s3Failure(status: number, body: string): IntegrationError {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  const message = `The bucket answered ${status}${code ? ` ${code}` : ""}.`;
  if (status === 403 || status === 401) {
    return new IntegrationError("warehouse_access_denied", message, { status });
  }
  if (status === 404 || code === "NoSuchBucket") {
    return new IntegrationError("warehouse_bucket_missing", message, { status });
  }
  if (status === 429 || status === 503 || status >= 500 || code === "SlowDown") {
    return new IntegrationError("warehouse_unavailable", message, { retryable: true, status });
  }
  return new IntegrationError("warehouse_rejected", message, { status });
}

/** The S3 provider over an injected HTTP client (fake in tests; fetch behind the SSRF guard in production). */
export function s3Provider(
  http: HttpClient,
  now: () => Date = () => new Date(),
): WarehouseProvider {
  return {
    provider: "S3",
    available: true,
    async put(target: WarehouseTarget, secret: string, object: WarehouseObject) {
      const credential = parseS3Credential(secret);
      const signed = signPut(
        target,
        credential,
        object.key,
        object.body,
        object.contentType,
        now(),
      );
      const response = await http({
        method: "PUT",
        url: signed.url,
        headers: signed.headers,
        body: object.body,
      });
      if (response.status < 200 || response.status > 299)
        throw s3Failure(response.status, response.body);
    },
  };
}
