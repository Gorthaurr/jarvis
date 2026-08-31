import { searchOwnCode } from "./self/repo.js";

const pats = [String.raw`^(\w+\s+)+$`, String.raw`^([\wа-яА-Я ]+ )+\.$`, String.raw`(\s|\w)+!$`, String.raw`^(.*,)+.*ZZZ$`];
for (const p of pats) {
  const t0 = Date.now();
  let hits = -1;
  let scanned = -1;
  try {
    const r = await searchOwnCode(p, { dir: "docs", maxHits: 3 });
    hits = r.hits.length;
    scanned = r.scannedFiles;
  } catch (e) {
    console.log("err", (e as Error).message);
  }
  console.log(JSON.stringify(p), "elapsed", Date.now() - t0, "ms, hits", hits, "scanned", scanned);
}
