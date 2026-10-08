import { z } from "zod";

/**
 * Sitemap file schema (Section 3.15: the sitemap is the single source of navigation).
 *
 * Zod checks the shape of a sitemap file. Cross-node rules (unique ids and routes,
 * label keys, visibility, depth, persona defaults, engagement tab sets) live in
 * `validate.ts`, because they need the whole tree and the message catalog.
 */

export const SHELLS = ["atlas", "gateway", "compass"] as const;
export type Shell = (typeof SHELLS)[number];

/**
 * Node kinds. `group` and `action` are containers and commands: they carry no route and
 * do not count toward navigation depth. Every other kind is navigable and has a route.
 */
export const NODE_KINDS = [
  "group",
  "item",
  "page",
  "tab",
  "section",
  "record",
  "mode",
  "action",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const NON_NAVIGABLE_KINDS: ReadonlySet<NodeKind> = new Set(["group", "action"]);

/** Where a group renders. `none` holds direct routes that no menu lists. */
export const PLACEMENTS = [
  "sidebar",
  "footer",
  "chrome",
  "account-menu",
  "top-bar",
  "avatar-menu",
  "tab-bar",
  "more-menu",
  "none",
] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** Section 4.5.9 key, plus the two compound values the role table uses. */
export const VISIBILITY_VALUES = [
  "full",
  "read",
  "assigned",
  "own-profile",
  "own-records",
  "hidden",
  "read-and-extend",
  "full-except-billing-and-legal",
] as const;
export type Visibility = (typeof VISIBILITY_VALUES)[number];

/** Values available to Gateway account roles and Compass audiences. */
export const BASIC_VISIBILITY_VALUES: readonly Visibility[] = [
  "full",
  "read",
  "assigned",
  "hidden",
];

/** The seven platform roles in band order (Section 8). */
export const ATLAS_ROLES = [
  "owner",
  "admin",
  "manager",
  "member",
  "collaborator",
  "field",
  "viewer",
] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

/** Internal personas (Section 4.1), each with role-default expanded sidebar groups (4.5.2). */
export const ATLAS_PERSONAS = [
  "org-owner",
  "org-admin",
  "producer",
  "department-head",
  "finance-lead",
  "production-coordinator",
  "field-supervisor",
  "field-employee",
] as const;
export type AtlasPersona = (typeof ATLAS_PERSONAS)[number];

/** The eight external role types (Section 4.4.2). */
export const EXTERNAL_ROLE_TYPES = [
  "client",
  "vendor",
  "contractor",
  "crew",
  "staff",
  "artist",
  "artist-representative",
  "sponsor",
] as const;
export type ExternalRoleType = (typeof EXTERNAL_ROLE_TYPES)[number];

/** Gateway visibility keys: a person without a company account, then the four account roles. */
export const GATEWAY_ACCOUNT_ROLES = [
  "individual",
  "account-owner",
  "account-admin",
  "account-finance",
  "account-member",
] as const;
export type GatewayAccountRole = (typeof GATEWAY_ACCOUNT_ROLES)[number];

/** Compass audiences (Section 4.5.7): internal field users, then every external role type. */
export const COMPASS_AUDIENCES = ["field", "field-supervisor", ...EXTERNAL_ROLE_TYPES] as const;
export type CompassAudience = (typeof COMPASS_AUDIENCES)[number];

export const SHELL_ROLES: Record<Shell, readonly string[]> = {
  atlas: ATLAS_ROLES,
  gateway: GATEWAY_ACCOUNT_ROLES,
  compass: COMPASS_AUDIENCES,
};

/** View types from the view registry (Section 11.15) that a collection route can offer. */
export const VIEW_TYPES = [
  "list",
  "table",
  "spreadsheet",
  "gallery",
  "board",
  "calendar",
  "resource-schedule",
  "timeline",
  "map",
  "site-plan",
  "tree",
  "matrix",
  "org-chart",
  "chart",
  "feed",
  "inbox",
  "split",
  "document",
] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** Which view types each shell offers at all (Section 11.15 table). */
export const SHELL_VIEWS: Record<Shell, readonly ViewType[]> = {
  atlas: VIEW_TYPES,
  gateway: [
    "list",
    "table",
    "spreadsheet",
    "gallery",
    "board",
    "calendar",
    "timeline",
    "map",
    "site-plan",
    "chart",
    "feed",
    "inbox",
    "split",
    "document",
  ],
  compass: [
    "list",
    "gallery",
    "board",
    "calendar",
    "resource-schedule",
    "map",
    "site-plan",
    "chart",
    "feed",
    "inbox",
    "split",
    "document",
  ],
};

/** Query parameters every list route accepts (Section 4.5.3, route conventions). */
export const LIST_QUERY_PARAMS = ["view", "group", "sort", "filter", "scope"] as const;

/** Typed route parameters. Display keys are uppercase so they never collide with static slugs. */
export const PARAM_TYPES = {
  slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "project-key": /^[A-Z]{2,5}$/,
  "record-key": /^[A-Z]{2,5}-[1-9][0-9]*$/,
  "display-key": /^[A-Z][A-Z0-9]{1,4}(?:-[A-Z0-9]+)+$/,
  handle: /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  token: /^[A-Za-z0-9_-]{16,128}$/,
} as const;
export type ParamType = keyof typeof PARAM_TYPES;
const PARAM_TYPE_NAMES = Object.keys(PARAM_TYPES) as [ParamType, ...ParamType[]];

/** Tags that compound visibility values resolve against. */
export const NODE_TAGS = ["billing", "legal", "extensions"] as const;
export type NodeTag = (typeof NODE_TAGS)[number];

/** Runtime conditions a node needs before it renders. */
export const CONDITIONS = [
  "partner-org",
  "desktop",
  "platform-domain",
  "company-account",
  "org-allows-personal-tokens",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const AUTH_MODES = ["session", "public", "token"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const SCAN_MODES = ["asset", "receiving", "credential", "lookup"] as const;
export type ScanMode = (typeof SCAN_MODES)[number];
export const SCAN_SCOPES = ["all", "own", "own-and-party", "assigned", "acknowledgment"] as const;

export const NODE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
export const LABEL_KEY = /^nav(?:\.[a-z][A-Za-z0-9]*)+$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]*$/;

const nodeId = z.string().regex(NODE_ID, "ids are lowercase, dotted and hyphenated");
const labelKey = z.string().regex(LABEL_KEY, "labels are i18n keys under the nav namespace");

export const ListSchema = z.strictObject({
  views: z.array(z.enum(VIEW_TYPES)).min(1),
  default: z.enum(VIEW_TYPES),
});

export interface SitemapNode {
  id: string;
  kind: NodeKind;
  label: string;
  route?: string | undefined;
  placement?: Placement | undefined;
  level?: "org" | "both" | undefined;
  auth?: AuthMode | undefined;
  servedBy?: Shell | undefined;
  visibility?: Record<string, Visibility> | undefined;
  visibilityFrom?: string | undefined;
  twin?: string | undefined;
  module?: string | undefined;
  tags?: NodeTag[] | undefined;
  conditions?: Condition[] | undefined;
  list?: z.infer<typeof ListSchema> | undefined;
  children?: SitemapNode[] | undefined;
}

export const NodeSchema: z.ZodType<SitemapNode> = z.lazy(() =>
  z.strictObject({
    id: nodeId,
    kind: z.enum(NODE_KINDS),
    label: labelKey,
    route: z.string().optional(),
    placement: z.enum(PLACEMENTS).optional(),
    level: z.enum(["org", "both"]).optional(),
    auth: z.enum(AUTH_MODES).optional(),
    servedBy: z.enum(SHELLS).optional(),
    visibility: z.record(z.string(), z.enum(VISIBILITY_VALUES)).optional(),
    visibilityFrom: nodeId.optional(),
    twin: nodeId.optional(),
    module: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    tags: z.array(z.enum(NODE_TAGS)).optional(),
    conditions: z.array(z.enum(CONDITIONS)).optional(),
    list: ListSchema.optional(),
    children: z.array(NodeSchema).optional(),
  }),
);

export const ParamSchema = z.strictObject({
  type: z.enum(PARAM_TYPE_NAMES),
  reserved: z.array(z.string()).optional(),
});

const EngagementTabSetSchema = z.union([
  z.strictObject({ tabs: z.array(nodeId).min(1) }),
  z.strictObject({
    tabs: z.array(nodeId).min(1),
    delegatesTo: z.enum(EXTERNAL_ROLE_TYPES),
    always: z.array(nodeId),
    scopes: z.record(z.string().regex(/^[a-z][a-z-]*$/), z.array(nodeId).min(1)),
  }),
]);
export type EngagementTabSet = z.infer<typeof EngagementTabSetSchema>;

export const EngagementTabsSchema = z.strictObject({
  container: nodeId,
  sets: z.record(z.string(), EngagementTabSetSchema),
});

export const ContentProfileSchema = z.strictObject({
  today: z.array(nodeId).min(1),
  scanModes: z.array(z.strictObject({ mode: z.enum(SCAN_MODES), scope: z.enum(SCAN_SCOPES) })),
});
export type ContentProfile = z.infer<typeof ContentProfileSchema>;

export const SitemapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  shell: z.enum(SHELLS),
  home: nodeId,
  params: z.record(z.string().regex(PARAM_NAME), ParamSchema),
  globalQuery: z.record(z.string().regex(PARAM_NAME), z.string().regex(PARAM_NAME)).optional(),
  audience: z.strictObject({
    dimension: z.enum(["platform-role", "account-role", "compass-audience"]),
    roles: z.array(z.string()).min(1),
    roleTypes: z.array(z.enum(EXTERNAL_ROLE_TYPES)).optional(),
  }),
  chrome: z.record(z.string().regex(/^[a-z][A-Za-z]*$/), z.array(nodeId).min(1)).optional(),
  personas: z.record(z.string(), z.array(nodeId)).optional(),
  engagementTabs: EngagementTabsSchema.optional(),
  scanContainer: nodeId.optional(),
  contentBlocks: z.array(z.strictObject({ id: nodeId, label: labelKey })).optional(),
  contentProfiles: z.record(z.string(), ContentProfileSchema).optional(),
  deepLinks: z
    .array(
      z.strictObject({
        pattern: z.string().regex(/^[a-z]+:\/\/[a-z0-9{}/.-]+$/i),
        node: nodeId,
      }),
    )
    .optional(),
  nodes: z.array(NodeSchema).min(1),
});

export type Sitemap = z.infer<typeof SitemapSchema>;
