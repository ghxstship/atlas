/**
 * report-run: the report.run and report.deliver workers with their file headers and email copy. The
 * .xlsx and PDF writers (exceljs, pdfkit) and Resend load only when a run needs them.
 */
export * from "../reports.ts";
export { lazyResendClient, readEmailEnv } from "@xos/email/env";
export { recipientAllowed } from "@xos/email/transport";
