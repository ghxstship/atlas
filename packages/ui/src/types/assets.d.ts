/** A static file import: Vite gives its URL, Next.js an object with the URL as `src`. */
declare module "*.svg" {
  const asset: string | { readonly src: string };
  export default asset;
}

/** Bundlers inline NODE_ENV, as Next.js declares it for the apps that consume this package. */
declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV?: string;
  }
}
