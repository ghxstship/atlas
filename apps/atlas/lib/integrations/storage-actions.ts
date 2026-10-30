"use server";

import type { FileMeta } from "@xos/integrations";
import type { IntegrationActionState } from "@xos/integrations/settings";
import { authorizeUrl, isOAuthStorageProvider } from "@xos/integrations/storage-oauth";
import { removeFileLink } from "@xos/data/storage-links";
import { untyped } from "@xos/data/untyped";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { storageCallbackUrl, storageOAuthClient } from "@/lib/integrations/storage-oauth";
import { contextFor } from "@/lib/platform/action-context";
import { observability } from "@/lib/observability";

/**
 * Storage link-in-place (B16, ADR 0155 D5; migration 3053). Connect with Google or Microsoft starts an authorization
 * code flow with PKCE S256 (app.begin_integration_oauth) and sends the Admin to the provider. Browsing and linking go
 * through the storage-browse Edge Function as the signed-in person: Atlas never reads a credential. Refusals come back
 * as storageLinks copy.
 */

export interface BrowseItem {
  readonly id: string;
  readonly name: string;
  readonly folder: boolean;
  readonly mimeType: string;
  readonly modifiedAt: string | null;
}

export interface BrowseState {
  readonly ok?: boolean;
  readonly items?: readonly BrowseItem[];
  readonly folderId?: string | null;
  readonly message?: string;
  readonly linkId?: string;
  readonly at?: number;
}

type T = (key: string, values?: Record<string, string | number>) => string;

const KNOWN = new Set([
  "storage_outside_link_folder",
  "storage_link_folder_missing",
  "integration_oauth_unsupported",
  "integration_oauth_redirect",
  "integration_not_connected",
  "credential_revoked",
  "oauth_not_configured",
  "provider_file_missing",
  "file_is_folder",
  "denied",
  "forbidden",
]);

async function copy(): Promise<T> {
  return (await getTranslations("storageLinks")) as unknown as T;
}

/** Connect with Google or Connect with Microsoft: the provider's consent screen, with this person's state. */
export async function connectStorageAction(
  _: IntegrationActionState,
  form: FormData,
): Promise<IntegrationActionState> {
  const ctx = await contextFor(form);
  const t = await copy();
  const id = z.uuid().safeParse(form.get("connectionId"));
  const provider = String(form.get("provider") ?? "");
  if (!id.success || !isOAuthStorageProvider(provider)) return { error: t("errors.unexpected") };
  const client = storageOAuthClient(provider);
  if (client === null) return { error: t("errors.oauth_not_configured") };
  const { data, error } = await untyped(ctx.viewer.db).rpc("begin_integration_oauth", {
    p_connection_id: id.data,
    p_redirect_uri: storageCallbackUrl(),
  });
  const row = (data as { state: string; code_challenge: string }[] | null)?.[0];
  if (error || !row) {
    const rule = error?.message.split(": ")[0] ?? "unexpected";
    return { error: t(`errors.${KNOWN.has(rule) ? rule : "unexpected"}`) };
  }
  redirect(
    authorizeUrl(provider, client.clientId, storageCallbackUrl(), row.state, row.code_challenge),
  );
}

/** The linking folder an Admin chose: Google's folder id, or OneDrive's item id within its drive. */
export async function setLinkingFolderAction(_: BrowseState, form: FormData): Promise<BrowseState> {
  const ctx = await contextFor(form);
  const t = await copy();
  const id = z.uuid().safeParse(form.get("connectionId"));
  const folder = z.string().min(1).max(500).safeParse(form.get("folderId"));
  if (!id.success || !folder.success) return { message: t("errors.unexpected"), at: Date.now() };
  const db = untyped(ctx.viewer.db);
  const { data: current } = await db
    .from("integration_connections")
    .select("provider_code, provider_settings")
    .eq("id", id.data)
    .single();
  const settings = { ...((current?.provider_settings as Record<string, unknown> | null) ?? {}) };
  // OneDrive ids are "<drive>/<item>": the drive is the connection's, the item is the root.
  const [drive, item] = folder.data.includes("/") ? folder.data.split("/", 2) : [null, folder.data];
  settings["link_root_id"] = item;
  if (drive && current?.provider_code === "onedrive_sharepoint") settings["drive_id"] = drive;
  const { error } = await db
    .from("integration_connections")
    .update({ provider_settings: settings })
    .eq("id", id.data);
  if (error) return { message: t("errors.denied"), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}/settings/integrations`);
  return { ok: true, message: t("folderSaved"), at: Date.now() };
}

async function browse(
  ctx: Awaited<ReturnType<typeof contextFor>>,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; rule: string }> {
  const { data, error } = await ctx.viewer.db.functions.invoke("storage-browse", { body });
  if (error) {
    let rule = "unexpected";
    try {
      const context = (error as { context?: Response }).context;
      const problem = context ? ((await context.json()) as { rule?: string }) : null;
      rule = problem?.rule ?? "unexpected";
    } catch (parse) {
      observability.logger.error("storage-browse answered without a problem", {
        error: String(parse),
      });
    }
    return { ok: false, rule: rule === "forbidden" ? "denied" : rule };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

function items(value: unknown): BrowseItem[] {
  return (Array.isArray(value) ? (value as FileMeta[]) : []).map((m) => ({
    id: m.externalFileId,
    name: m.name,
    folder: m.folder,
    mimeType: m.mimeType,
    modifiedAt: m.modifiedAt,
  }));
}

/** Lists a folder: inside the linking folder for a document writer, the whole account for an Admin choosing it. */
export async function browseStorageAction(_: BrowseState, form: FormData): Promise<BrowseState> {
  const ctx = await contextFor(form);
  const t = await copy();
  const admin = form.get("mode") === "admin";
  const folderId =
    typeof form.get("folderId") === "string" && form.get("folderId") !== ""
      ? String(form.get("folderId"))
      : null;
  const answer = await browse(ctx, {
    action: admin ? "admin_list" : "list",
    connection_id: String(form.get("connectionId") ?? ""),
    document_id: String(form.get("documentId") ?? ""),
    folder_id: folderId,
  });
  if (!answer.ok)
    return {
      message: t(`errors.${KNOWN.has(answer.rule) ? answer.rule : "unexpected"}`),
      at: Date.now(),
    };
  return { ok: true, items: items(answer.data["items"]), folderId, at: Date.now() };
}

/** Links one file in place on a document, as the person (the 0625 write rule applies). */
export async function linkStorageFileAction(_: BrowseState, form: FormData): Promise<BrowseState> {
  const ctx = await contextFor(form);
  const t = await copy();
  const answer = await browse(ctx, {
    action: "link",
    connection_id: String(form.get("connectionId") ?? ""),
    document_id: String(form.get("documentId") ?? ""),
    external_file_id: String(form.get("fileId") ?? ""),
  });
  if (!answer.ok)
    return {
      message: t(`errors.${KNOWN.has(answer.rule) ? answer.rule : "unexpected"}`),
      at: Date.now(),
    };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return {
    ok: true,
    linkId: String(answer.data["link_id"] ?? ""),
    message: t("linked", { name: String(answer.data["file_name"] ?? "") }),
    at: Date.now(),
  };
}

export async function removeFileLinkAction(_: BrowseState, form: FormData): Promise<BrowseState> {
  const ctx = await contextFor(form);
  const t = await copy();
  const id = z.uuid().safeParse(form.get("linkId"));
  if (!id.success) return { message: t("errors.unexpected"), at: Date.now() };
  const result = await removeFileLink(ctx.viewer.db, id.data);
  if (!result.ok) return { message: t("errors.denied"), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, message: t("removed"), at: Date.now() };
}
