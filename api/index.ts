/**
 * Vercel's entry point. Deliberately three lines.
 *
 * The handler itself lives in `server/vercel-entry.ts`, which the server
 * tsconfig typechecks; this file imports the *bundled* artifact the build
 * produces. That indirection is not ceremony — the first attempt imported the
 * TypeScript source directly and Vercel compiled this file without following
 * the import, so every request died with ERR_MODULE_NOT_FOUND on
 * `/var/task/server/storefront-server`. Importing one self-contained .js file
 * leaves nothing to resolve.
 */
export { default } from '../dist/api/handler.js'
