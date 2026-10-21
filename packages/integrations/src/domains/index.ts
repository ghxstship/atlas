/**
 * Custom domain provisioning (A79, Section 12): ports, the Vercel Domains and Resend domains adapters, and the
 * worker. Self-contained apart from the framework's HTTP client and errors, so the Edge bundle can carry it.
 */
export type {
  DnsRecord,
  DomainProviders,
  HostProvider,
  ProviderState,
  SendingDomainProvider,
} from "./types.ts";
export {
  VERCEL_API,
  VERCEL_APEX_IP,
  VERCEL_CNAME,
  vercelHosts,
  vercelRecords,
  type VercelConfig,
} from "./vercel.ts";
export {
  RESEND_API,
  dmarcRecord,
  resendRecords,
  resendSendingDomains,
  type ResendConfig,
} from "./resend.ts";
export {
  DOMAIN_JOB_KINDS,
  NOT_CONFIGURED,
  runDomainJobs,
  supabaseDomainJobStore,
  type DomainJob,
  type DomainJobKind,
  type DomainJobResult,
  type DomainRecord,
  type DomainRow,
  type DomainStore,
  type RpcClient,
} from "./provisioning.ts";
export { httpFromFetch, type FetchLike, type HttpClient } from "../framework/http.ts";
