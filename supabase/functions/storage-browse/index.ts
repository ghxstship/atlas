// storage-browse (B16, RRR-240; ADR 0155 D5, migration 3053): a document writer browses the linking folder of the org's
// Google Drive or OneDrive connection and links a file in place; an integrations Admin browses the whole account to
// choose that folder. Atlas never reads credentials: this function checks the caller first, as the caller
// (app.authorize_storage_link or app.authorize_storage_admin), and only then reads the credential with the service
// role, renewing it 5 minutes before it expires. A writer sees and links only what lies inside the linking folder
// (storage_outside_link_folder otherwise). The link is inserted as the caller, so the document's write rule and the
// file link guard (0625) apply.
//
// POST, verify_jwt = true, the person's session as the bearer. Body: { action: "list", connection_id, document_id,
// folder_id } | { action: "link", connection_id, document_id, external_file_id } | { action: "admin_list",
// connection_id, folder_id }.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), and the platform
// OAuth apps XOS_GOOGLE_STORAGE_CLIENT_ID and _SECRET and XOS_MICROSOFT_STORAGE_CLIENT_ID and _SECRET.
import { createClient } from "@supabase/supabase-js";
import {
  IntegrationError,
  freshAccessToken,
  httpFromFetch,
  isOAuthStorageProvider,
  oauthClientFromEnv,
  storageProviderFor,
} from "../_vendor/storage-browse.js";
import { env, json, serve } from "../_shared/runtime.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status: number, rule: string, detail: string): Response {
  return json(status, { type: `/problems/${rule}`, title: rule, status, rule, detail });
}

/** A database error as a problem: 42501 is 403, a refusal (XR001) names its rule. */
function databaseProblem(error: { code?: string; message: string }): Response {
  if (error.code === "42501")
    return problem(403, "forbidden", "You cannot link files to this document.");
  if (error.code === "XR001") {
    const at = error.message.indexOf(": ");
    return problem(
      409,
      at > 0 ? error.message.slice(0, at) : "refused",
      at > 0 ? error.message.slice(at + 2) : error.message,
    );
  }
  throw new Error(error.message);
}

serve(async (request) => {
  if (request.method !== "POST") return problem(405, "method_not_allowed", "Use POST.");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return problem(401, "unauthorized", "Sign in first.");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return problem(400, "invalid_body", "Send a JSON object.");
  }
  const action = body["action"];
  const connectionId = String(body["connection_id"] ?? "");
  const documentId = String(body["document_id"] ?? "");
  const folderId =
    typeof body["folder_id"] === "string" && body["folder_id"] !== "" ? body["folder_id"] : null;
  if (!UUID.test(connectionId) || (action !== "admin_list" && !UUID.test(documentId))) {
    return problem(400, "invalid_body", "Name the connection and the document.");
  }

  const url = env("SUPABASE_URL");
  const person = createClient(url, env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  }).schema("app");
  const service = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  }).schema("app");

  // The caller first: no credential is read for someone who may not use it.
  const check =
    action === "admin_list"
      ? await person.rpc("authorize_storage_admin", { p_connection_id: connectionId })
      : action === "list" || action === "link"
        ? await person.rpc("authorize_storage_link", {
            p_connection_id: connectionId,
            p_document_id: documentId,
          })
        : null;
  if (check === null) return problem(400, "invalid_action", "action is list, link or admin_list.");
  if (check.error) return databaseProblem(check.error);

  const { data: connection, error: connectionError } = await service
    .from("integration_connections")
    .select("id, provider_code, provider_settings")
    .eq("id", connectionId)
    .single();
  if (connectionError || !connection)
    throw new Error(connectionError?.message ?? "connection missing");
  const providerCode = String(connection.provider_code);
  const provider = storageProviderFor(providerCode);
  if (provider === null || !isOAuthStorageProvider(providerCode)) {
    return problem(
      409,
      "integration_oauth_unsupported",
      "Files are linked in place from Google Drive or OneDrive.",
    );
  }
  const settings = (connection.provider_settings ?? {}) as Record<string, unknown>;
  const { data: secret, error: secretError } = await service.rpc("read_integration_credential", {
    p_connection_id: connectionId,
  });
  if (secretError) return databaseProblem(secretError);

  const http = httpFromFetch((input, init) => fetch(input, init));
  let token: string;
  try {
    token = await freshAccessToken(
      http,
      providerCode,
      oauthClientFromEnv(providerCode, Deno.env.toObject()),
      String(secret ?? ""),
      async (next: string) => {
        const { error } = await service.rpc("store_integration_credential", {
          p_connection_id: connectionId,
          p_secret: next,
          p_kind: "OAuth Token",
          p_expires_at: null,
        });
        if (error) throw new Error(error.message);
      },
    );
  } catch (error) {
    if (error instanceof IntegrationError) return problem(409, error.code, error.message);
    throw error;
  }
  const context = {
    http,
    credential: { token, fields: {} },
    connection: { id: connectionId, providerCode, settings },
    now: () => new Date(),
  } as unknown as Parameters<typeof provider.listFolder>[0];

  const drive = typeof settings["drive_id"] === "string" ? settings["drive_id"] : "";
  const rootSetting = typeof settings["link_root_id"] === "string" ? settings["link_root_id"] : "";
  const root = providerCode === "onedrive_sharepoint" ? `${drive}/${rootSetting}` : rootSetting;
  const inside = async (id: string) =>
    id === root || (await provider.inFolder?.(context, id, root)) === true;

  try {
    if (action === "admin_list") {
      const items = await provider.listFolder(context, folderId);
      return json(200, { items });
    }
    if (action === "list") {
      if (folderId !== null && !(await inside(folderId))) {
        return problem(
          403,
          "storage_outside_link_folder",
          "Only the folder an Admin chose for linking can be browsed.",
        );
      }
      const items = await provider.listFolder(context, folderId ?? root);
      return json(200, { items, root });
    }
    const fileId = String(body["external_file_id"] ?? "");
    if (fileId.length === 0 || fileId.length > 500)
      return problem(400, "invalid_body", "Name the file to link.");
    if (!(await inside(fileId))) {
      return problem(
        403,
        "storage_outside_link_folder",
        "Only files inside the folder an Admin chose can be linked.",
      );
    }
    const meta = await provider.metadata(context, fileId);
    if (meta === null)
      return problem(404, "provider_file_missing", `${provider.label} no longer has this file.`);
    if (meta.folder) return problem(409, "file_is_folder", "Link a file, not a folder.");
    const { data: link, error } = await person
      .from("integration_file_links")
      .insert({
        integration_connection_id: connectionId,
        document_id: documentId,
        link_mode: "Link",
        external_file_id: meta.externalFileId,
        file_name: meta.name.slice(0, 255),
        mime_type: meta.mimeType,
        size_bytes: meta.sizeBytes,
        web_url: meta.webUrl,
        external_version: meta.version,
        external_modified_at: meta.modifiedAt,
      })
      .select("id")
      .single();
    if (error) return databaseProblem(error);
    return json(201, { link_id: link.id, file_name: meta.name, web_url: meta.webUrl });
  } catch (error) {
    if (error instanceof IntegrationError)
      return problem(error.status === 404 ? 404 : 409, error.code, error.message);
    throw error;
  }
});
