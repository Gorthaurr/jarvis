import { readFile } from "node:fs/promises";
import { searchOwnCode, selfRepoRoot } from "./self/repo.js";
import { join } from "node:path";

const t1 = Date.now();
const base = await searchOwnCode("НЕТ_ТАКОЙ_СТРОКИ_12345", { dir: "docs", maxHits: 3 });
console.log("baseline literal scan:", Date.now() - t1, "ms, scanned", base.scannedFiles);

// одна конкретная строка + одна регулярка: блокируется ли поток целиком
const root = selfRepoRoot();
const text = await readFile(join(root, "docs/CODE_REVIEW_2026-07-02.md"), "utf8");
const longest = text.split(/\r?\n/).reduce((a, b) => (b.length > a.length ? b : a), "");
console.log("longest docs line chars:", longest.length);
const re = new RegExp(String.raw`^(\w+\s+)+$`, "i");
for (const n of [40, 60, 80, 100, 120]) {
  const s = longest.slice(0, n);
  const t0 = Date.now();
  re.test(s);
  console.log("prefix", n, "chars ->", Date.now() - t0, "ms (синхронно, поток занят)");
}
