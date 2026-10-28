/**
 * Node module hook for the CLIs that run on Node's type stripping: a relative import without an
 * extension (`./routes`), as the workspace's TypeScript sources write them for TypeScript and Vite,
 * resolves to its `.ts` file. Registered by register-ts.mjs.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier)) throw error;
    return next(`${specifier}.ts`, context);
  }
}
