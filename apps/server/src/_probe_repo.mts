import { resolveOwnPath, readOwnFile, selfRepoRoot } from "./self/repo.js";
const root = selfRepoRoot();
console.log("ROOT:", root);
const cases = [
  "apps/server/Data/profile.json",
  "apps/server/DATA/memory",
  "apps/server/data/profile.json",
  "Node_Modules/.bin/tsx",
  ".Git/config",
  "logs/client.err.log",
  "logs/server.out.log",
  "server.log",
  "apps/server/Data/credentials-master.key",
  "data/consent.json",
  "Data/consent.json",
];
for (const c of cases) console.log(c, "->", resolveOwnPath(c) ? "ALLOWED" : "blocked");
async function tryRead(p: string, limit = 3) {
  try {
    const f = await readOwnFile(p, { limit });
    console.log("READ", p, "OK:", JSON.stringify(f.lines.join(" / ")).slice(0, 260));
  } catch (e) { console.log("READ", p, "ERR:", (e as Error).message); }
}
await tryRead("apps/server/Data/profile.json");
await tryRead("logs/client.err.log", 2);
await tryRead("logs/server.out.log", 2);
await tryRead("apps/server/DATA/logs");
