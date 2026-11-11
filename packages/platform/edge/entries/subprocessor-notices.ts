/**
 * subprocessor-notices (A82): the platform email worker for Subprocessor List confirmations and notices.
 * React Email, the templates and Resend and the worker itself load only when a request comes (@xos/email).
 */
export const loadSubprocessorNotices = () => import("../subprocessor-notices-worker.ts");
