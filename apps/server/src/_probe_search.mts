import { searchOwnCode, readOwnFile } from "./self/repo.js";
const r = await searchOwnCode(".", { dir: "apps/server/Data", maxHits: 6 });
console.log("hits in Data:", r.hits.map(h => `${h.path}:${h.line}: ${h.text.slice(0,80)}`));
console.log("scanned:", r.scannedFiles, "capped:", r.capped);
try {
  const f = await readOwnFile("apps/server/Data/memory/00000000-0000-0000-0000-000000000001.json", { limit: 1 });
  console.log("memory read OK, first 200:", f.lines.join("").slice(0, 200));
} catch (e) { console.log("memory read ERR:", (e as Error).message); }
// ReDoS
const t0 = Date.now();
const rr = await searchOwnCode("^(\s*\w+\s*)+$", { dir: "apps/server/src/brain", maxHits: 3 });
console.log("redos elapsed ms:", Date.now() - t0, "hits:", rr.hits.length);
