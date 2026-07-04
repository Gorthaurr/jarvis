function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function skillTokens(s) {
  const norm = s.toLowerCase().replace(/ё/g, "е");
  return (norm.match(/[a-zа-я0-9]+/gu) ?? []).filter((w) => w.length >= 4);
}

function tokenHit(q, target) {
  if (q.has(target)) return true;
  for (const w of q) {
    const need = Math.max(5, Math.ceil(0.75 * Math.min(w.length, target.length)));
    if (commonPrefixLen(w, target) >= need) return true;
  }
  return false;
}

const query = "пришли отчёт в телеграм";
const skill = { id: "tg", name: "Отчёт в Telegram", when: "прислать отчёт в телеграм" };

const q = new Set(skillTokens(query));
const targets = [...new Set(skillTokens(`${skill.name} ${skill.when}`))];

console.log("Query tokens:", Array.from(q));
console.log("Skill targets:", targets);

let hits = 0;
for (const t of targets) {
  const hit = tokenHit(q, t);
  if (hit) {
    console.log(`✓ tokenHit → "${t}"`);
    hits++;
  }
}

console.log(`\nTotal hits: ${hits}`);
console.log(`Score: ${hits}/${Math.min(q.size, targets.length)} = ${(hits / Math.min(q.size, targets.length)).toFixed(2)}`);
console.log(`Passes hits>=2? ${hits >= 2}`);
