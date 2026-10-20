// Prints how many sitemap routes each review role can see (A59). Usage: node routes.mjs
import { join } from "node:path";
import { jiti, ROOT } from "./lib.mjs";
import { atlasRoles, gatewayPeople, atlasRoutes, gatewayRoutes } from "./plan.mjs";

const ia = await jiti.import(join(ROOT, "packages/ia/src/index.ts"));
const atlas = await jiti.import(join(ROOT, "apps/atlas/ia/sitemap.generated.ts"));
const gateway = await jiti.import(join(ROOT, "apps/gateway/ia/sitemap.generated.ts"));
for (const r of atlasRoles) {
  const list = atlasRoutes(ia, atlas.sitemap, r);
  console.log(`atlas ${r.role}: ${list.length}`);
}
for (const p of gatewayPeople) {
  const list = gatewayRoutes(ia, gateway.sitemap, p);
  console.log(`gateway ${p.person}: ${list.length}`);
}
