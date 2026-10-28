import type { TemplateCode } from "./index.tsx";

/**
 * Every template code, without React. isTemplateCode reads this list, so code that only checks or
 * routes a template never loads React Email; renderEmail loads the templates when it renders (A85,
 * Edge Function cold starts). The tests check it lists exactly the templates in index.tsx.
 */
export const TEMPLATE_CODES = [
  "notification",
  "digest",
  "invite",
  "report_delivery",
  "export_ready",
  "import_finished",
  "dsar_received",
  "subprocessor_confirm",
  "subprocessor_notice",
  "party_invitation",
] as const satisfies readonly TemplateCode[];
