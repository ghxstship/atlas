/**
 * scim: the SCIM 2.0 handler (A77) from @xos/integrations, which depends on this package, so it is
 * bundled by path rather than as a dependency.
 */
export {
  handleScimRequest,
  serveScim,
  supabaseAuthAdmin,
  supabaseScimStore,
} from "../../../integrations/src/identity/scim.ts";
