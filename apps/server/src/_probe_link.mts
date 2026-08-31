import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveOwnPath, readOwnFile, selfRepoRoot, searchOwnCode } from "./self/repo.js";
const root = selfRepoRoot();
const sandbox = join(root, "apps/server/src/_probe_link_dir");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
// 1) junction на каталог ВНЕ репозитория (домашний каталог владельца)
const home = process.env.USERPROFILE!;
try { symlinkSync(join(home, ".claude"), join(sandbox, "notes"), "junction"); } catch (e) { console.log("junction err", (e as Error).message); }
console.log("junction path allowed?", !!resolveOwnPath("apps/server/src/_probe_link_dir/notes/settings.json"));
try {
  const f = await readOwnFile("apps/server/src/_probe_link_dir/notes/settings.json", { limit: 3 });
  console.log("READ OUTSIDE via junction OK:", JSON.stringify(f.lines.join(" / ")).slice(0, 200));
} catch (e) { console.log("READ outside ERR:", (e as Error).message); }
// 2) symlink на .env репозитория под безобидным именем
try { symlinkSync(join(root, ".env"), join(sandbox, "notes.ts"), "file"); } catch (e) { console.log("symlink err", (e as Error).message); }
try {
  const f = await readOwnFile("apps/server/src/_probe_link_dir/notes.ts", { limit: 3 });
  console.log("READ .env via alias OK:", JSON.stringify(f.lines.join(" / ")).slice(0, 160));
} catch (e) { console.log("READ .env alias ERR:", (e as Error).message); }
const r = await searchOwnCode("KEY", { dir: "apps/server/src/_probe_link_dir", maxHits: 5 });
console.log("SEARCH via alias hits:", r.hits.map(h=>h.path+":"+h.line+": "+h.text.slice(0,40)));
rmSync(sandbox, { recursive: true, force: true });
console.log("cleanup:", !existsSync(sandbox));
