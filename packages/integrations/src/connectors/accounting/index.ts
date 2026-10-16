import type { Connector } from "../../framework/connector.ts";
import { accountingConnector } from "./connector.ts";
import { netSuiteProvider, quickBooksProvider, rampProvider, xeroProvider } from "./providers.ts";
import type { AccountingSource } from "./source.ts";

export * from "./connector.ts";
export * from "./providers.ts";
export * from "./source.ts";

/** The Xero, QuickBooks Online, NetSuite and Ramp connectors over one accounting source. */
export function accountingConnectors(source: AccountingSource): Connector[] {
  return [
    xeroProvider(source),
    quickBooksProvider(source),
    netSuiteProvider(source),
    rampProvider(source),
  ].map((p) => accountingConnector(p, source));
}
