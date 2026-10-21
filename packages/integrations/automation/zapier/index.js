/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports -- a Zapier CLI app is CommonJS and loads its platform with require. */
"use strict";

/**
 * The XOS app for Zapier (Section 17 Automation; A83, finding A65-013), built only on the public API v1 and its
 * webhooks. Triggers are REST hooks: subscribing creates a webhook endpoint (webhookEndpoints.create) for one
 * event, unsubscribing deletes it, and every delivery is checked against the endpoint's signing secret
 * (XOS-Signature, HMAC-SHA256 of "{timestamp}.{body}"). Actions and searches call v1 operations with an org API
 * key (Authorization: Bearer xos_live_...). Every request this file makes is validated against
 * packages/api/openapi/v1.json by packages/integrations/test/automation.test.ts.
 *
 * Publishing is an owner step (infra/runbooks/integrations.md): `zapier-platform register`, `zapier-platform push`,
 * then the Zapier review. Platform 19.1.0 on Node 22; the app stays CommonJS, which platform 19 still supports. OAuth replaces the API key once the XOS authorization server ships.
 */

const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");

const DEFAULT_BASE_URL = "https://api.ghxstship.tech/v1";

const baseUrl = (bundle) =>
  String(bundle.authData.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");

/** A fresh Idempotency-Key for each POST (the API requires one on every POST). */
const idempotencyKey = (z, bundle) =>
  z.hash("sha256", `${JSON.stringify(bundle.inputData || {})}:${Date.now()}:${Math.random()}`);

const addApiKey = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.api_key) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
    request.headers.Accept = "application/json";
  }
  return request;
};

/** Problem responses (RFC 9457) become errors that say what the API said. */
const handleProblems = (response, z) => {
  if (response.status >= 400) {
    let detail;
    try {
      const problem = JSON.parse(response.content);
      detail = problem.detail || problem.title || response.content;
    } catch (error) {
      detail = `${response.content} (${String(error)})`;
    }
    throw new z.errors.Error(String(detail).slice(0, 500), "XOSApiError", response.status);
  }
  return response;
};

const authentication = {
  type: "custom",
  fields: [
    {
      key: "api_key",
      label: "API Key",
      required: true,
      type: "password",
      helpText:
        "An org API key from Atlas: Settings, API keys and service accounts. It starts with xos_live_ and carries the scopes the Zap needs.",
    },
    {
      key: "base_url",
      label: "API Address",
      required: false,
      default: DEFAULT_BASE_URL,
      helpText:
        "Leave as is for GHXSTSHIP hosted XOS. A self-hosted deployment uses https://<its host>/api/v1.",
    },
  ],
  test: async (z, bundle) => {
    const response = await z.request({ method: "GET", url: `${baseUrl(bundle)}/me` });
    return response.data;
  },
  connectionLabel: "{{active_organization_id}}",
};

/** Trigger catalog: the webhook event, and the list operation a sample comes from. */
const TRIGGERS = [
  {
    key: "record_created",
    event: "record.created",
    noun: "Record",
    label: "New Record",
    list: "/records",
  },
  {
    key: "record_state_changed",
    event: "record.state_changed",
    noun: "Record",
    label: "Record State Changed",
    list: "/records",
  },
  {
    key: "project_created",
    event: "project.created",
    noun: "Project",
    label: "New Project",
    list: "/projects",
  },
  {
    key: "invoice_issued",
    event: "invoice.issued",
    noun: "Invoice",
    label: "Invoice Issued",
    list: "/invoices",
  },
  {
    key: "po_approved",
    event: "po.approved",
    noun: "Purchase Order",
    label: "Purchase Order Approved",
    list: "/purchase-orders",
  },
  {
    key: "incident_reported",
    event: "incident.reported",
    noun: "Incident",
    label: "Incident Reported",
    list: "/incidents",
  },
  {
    key: "timesheet_approved",
    event: "timesheet.approved",
    noun: "Timesheet",
    label: "Timesheet Approved",
    list: "/timesheets",
  },
];

/** Constant-time comparison of two hex strings. */
const sameHex = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Checks XOS-Signature (t={seconds},v1={hex}[,v1={hex}]) on the raw body; refuses deliveries older than five minutes. */
const verifyDelivery = (z, bundle) => {
  const secret = bundle.subscribeData && bundle.subscribeData.signing_secret;
  const raw = bundle.rawRequest || {};
  const headers = raw.headers || {};
  const header =
    headers["Http-Xos-Signature"] || headers["XOS-Signature"] || headers["xos-signature"] || "";
  if (!secret) return;
  const parts = String(header).split(",");
  const t = (parts.find((p) => p.startsWith("t=")) || "").slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300)
    throw new z.errors.HaltedError("Stale or unsigned delivery.");
  const expected = z.hash("sha256", `${t}.${raw.content || ""}`, secret);
  if (!signatures.some((s) => sameHex(s, expected)))
    throw new z.errors.HaltedError("The delivery signature does not match.");
};

const triggerFor = (spec) => ({
  key: spec.key,
  noun: spec.noun,
  display: {
    label: spec.label,
    description: `Triggers when XOS sends the ${spec.event} webhook event.`,
  },
  operation: {
    type: "hook",
    performSubscribe: async (z, bundle) => {
      const response = await z.request({
        method: "POST",
        url: `${baseUrl(bundle)}/webhook-endpoints`,
        headers: { "Idempotency-Key": idempotencyKey(z, bundle) },
        body: { url: bundle.targetUrl, events: [spec.event], description: `Zapier: ${spec.label}` },
      });
      return response.data;
    },
    performUnsubscribe: async (z, bundle) => {
      await z.request({
        method: "DELETE",
        url: `${baseUrl(bundle)}/webhook-endpoints/${encodeURIComponent(bundle.subscribeData.webhook_endpoint_id)}`,
      });
      return {};
    },
    perform: (z, bundle) => {
      verifyDelivery(z, bundle);
      return [bundle.cleanedRequest];
    },
    performList: async (z, bundle) => {
      const response = await z.request({
        method: "GET",
        url: `${baseUrl(bundle)}${spec.list}`,
        params: { limit: 3, sort: "-updated_at" },
      });
      return (response.data.data || []).map((row) => ({
        id: row.id,
        type: spec.event,
        occurred_at: row.updated_at,
        project_id: row.project_id || null,
        subject: { table: spec.list.slice(1).replace(/-/g, "_"), id: row.id },
        data: row,
      }));
    },
    sample: {
      id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
      type: spec.event,
      occurred_at: "2026-10-08T14:30:00Z",
      project_id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e70",
      subject: {
        table: spec.list.slice(1).replace(/-/g, "_"),
        id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e71",
      },
      data: {},
    },
  },
});

/** A create: POST to a v1 collection with the input fields as the body. */
const createFor = (spec) => ({
  key: spec.key,
  noun: spec.noun,
  display: { label: spec.label, description: spec.description },
  operation: {
    inputFields: spec.inputFields,
    perform: async (z, bundle) => {
      const body = {};
      for (const field of spec.inputFields) {
        const value = bundle.inputData[field.key];
        if (value !== undefined && value !== "") body[field.key] = value;
      }
      const response = await z.request({
        method: "POST",
        url: `${baseUrl(bundle)}${spec.path}`,
        headers: { "Idempotency-Key": idempotencyKey(z, bundle) },
        body,
      });
      return response.data;
    },
    sample: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
  },
});

const CREATES = [
  createFor({
    key: "create_comment",
    noun: "Comment",
    label: "Add Comment",
    description: "Adds a comment to a comment thread.",
    path: "/comments",
    inputFields: [
      { key: "comment_thread_id", label: "Comment Thread ID", required: true },
      { key: "body", label: "Comment", required: true, type: "text" },
      { key: "source", label: "Source", required: false, choices: ["API"], default: "API" },
    ],
  }),
  createFor({
    key: "create_incident",
    noun: "Incident",
    label: "Report Incident",
    description: "Reports an incident on a project.",
    path: "/incidents",
    inputFields: [
      { key: "project_id", label: "Project ID", required: true },
      { key: "title", label: "Title", required: true },
      { key: "occurred_at", label: "Occurred At", required: true, type: "datetime" },
      {
        key: "severity_enum_id",
        label: "Severity",
        required: true,
        helpText: "A row of the Incident Severity enumeration, for example ENM-097.",
      },
    ],
  }),
  createFor({
    key: "create_venue",
    noun: "Venue",
    label: "Create Venue",
    description: "Creates a venue.",
    path: "/venues",
    inputFields: [
      { key: "name", label: "Name", required: true },
      { key: "street_address", label: "Street Address", required: false },
      { key: "locality", label: "City", required: false },
      { key: "postal_code", label: "Postal Code", required: false },
      {
        key: "jurisdiction_id",
        label: "Jurisdiction",
        required: true,
        helpText: "For example US-FL-MIAMI-DADE.",
      },
      {
        key: "time_zone",
        label: "Time Zone",
        required: true,
        helpText: "An IANA time zone, for example America/New_York.",
      },
    ],
  }),
  {
    key: "update_record",
    noun: "Record",
    display: {
      label: "Update Record",
      description: "Changes a record's title, description or due date.",
    },
    operation: {
      inputFields: [
        { key: "id", label: "Record ID", required: true },
        { key: "title", label: "Title", required: false },
        { key: "description", label: "Description", required: false, type: "text" },
        { key: "due_at", label: "Due At", required: false, type: "datetime" },
      ],
      perform: async (z, bundle) => {
        const url = `${baseUrl(bundle)}/records/${encodeURIComponent(bundle.inputData.id)}`;
        const current = await z.request({ method: "GET", url });
        const body = {};
        for (const key of ["title", "description", "due_at"]) {
          if (bundle.inputData[key] !== undefined && bundle.inputData[key] !== "")
            body[key] = bundle.inputData[key];
        }
        const response = await z.request({
          method: "PATCH",
          url,
          headers: { "If-Match": current.headers.get("etag") || "" },
          body,
        });
        return response.data;
      },
      sample: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", record_key: "NWL-24-11" },
    },
  },
];

/** A search: one v1 list operation filtered by a key field. */
const searchFor = (spec) => ({
  key: spec.key,
  noun: spec.noun,
  display: { label: spec.label, description: spec.description },
  operation: {
    inputFields: [{ key: spec.field, label: spec.fieldLabel, required: true }],
    perform: async (z, bundle) => {
      const response = await z.request({
        method: "GET",
        url: `${baseUrl(bundle)}${spec.path}`,
        params: { [`filter[${spec.field}][eq]`]: bundle.inputData[spec.field], limit: 1 },
      });
      return response.data.data || [];
    },
    sample: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" },
  },
});

const SEARCHES = [
  searchFor({
    key: "find_record",
    noun: "Record",
    label: "Find Record",
    description: "Finds a record by its key, for example NWL-24-11.",
    path: "/records",
    field: "record_key",
    fieldLabel: "Record Key",
  }),
  searchFor({
    key: "find_project",
    noun: "Project",
    label: "Find Project",
    description: "Finds a project by its key, for example NWL-24.",
    path: "/projects",
    field: "project_key",
    fieldLabel: "Project Key",
  }),
];

const byKey = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleProblems],
  triggers: byKey(TRIGGERS.map(triggerFor)),
  creates: byKey(CREATES),
  searches: byKey(SEARCHES),
};
