// Реплика failing input из review-находки
// Навык: name='Отправь файл', when='когда нужно отправить файл'
// Пользователь: 'пришли файлик'

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

function matchLearnedSkill(text, skills) {
  const q = new Set(skillTokens(text));
  console.log("Query tokens:", Array.from(q));
  if (q.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    const targets = [...new Set(skillTokens(`${s.name} ${s.when}`))];
    console.log(`Skill "${s.name}": targets =`, targets);
    if (targets.length === 0) continue;
    let hits = 0;
    for (const t of targets) {
      const hit = tokenHit(q, t);
      if (hit) {
        console.log(`  tokenHit("${Array.from(q)}", "${t}") = true`);
        hits++;
      } else {
        console.log(`  tokenHit("${Array.from(q)}", "${t}") = false`);
        // Детализация для debug
        for (const w of q) {
          const prefixLen = commonPrefixLen(w, t);
          const need = Math.max(5, Math.ceil(0.75 * Math.min(w.length, t.length)));
          console.log(`    "${w}" vs "${t}": prefixLen=${prefixLen}, need=${need}`);
        }
      }
    }
    const score = hits / Math.min(q.size, targets.length);
    console.log(`  Score: ${hits}/${Math.min(q.size, targets.length)} = ${score}`);
    if (hits >= 2 && (score > bestScore || (score === bestScore && best !== null && s.id < best.id))) {
      best = s;
      bestScore = score;
    }
  }
  const RECALL_MIN_SCORE = 0.34;
  console.log(`Best: ${best ? best.id : "null"}, bestScore=${bestScore}, threshold=${RECALL_MIN_SCORE}`);
  return bestScore >= RECALL_MIN_SCORE ? best : null;
}

// TEST CASE 1: из заявленного failing input
console.log("\n=== TEST 1: Синоним отправить/пришли ===");
const skill1 = [
  { id: "send_file", name: "Отправь файл", when: "когда нужно отправить файл", procedure: "..." },
];
const result1 = matchLearnedSkill("пришли файлик", skill1);
console.log("Result:", result1 ? result1.id : "null");
console.log("EXPECTED: должен найти skill (семантически 'пришли' ≈ 'отправь'), но из-за tokenHit ТОЛЬКО префикс → ПРОВАЛ");

// TEST CASE 2: закрыть окно / вырубить окна
console.log("\n=== TEST 2: Морфология + синоним ===");
const skill2 = [
  { id: "close_win", name: "Закрыть окно", when: "закрыть окна", procedure: "..." },
];
const result2 = matchLearnedSkill("вырубить окна", skill2);
console.log("Result:", result2 ? result2.id : "null");
console.log("EXPECTED: 'вырубить' vs 'закрыть' = 0 префикс → ПРОВАЛ (но 'окна' совпадает)");

// TEST CASE 3: проверим морфологию, которая ДОЛЖНА работать
console.log("\n=== TEST 3: Морфология, которая РАБОТАЕТ (отправь/отправить) ===");
const skill3 = [
  { id: "send", name: "Отправить", when: "отправить сообщение", procedure: "..." },
];
const result3 = matchLearnedSkill("отправь", skill3);
console.log("Result:", result3 ? result3.id : "null");
console.log("EXPECTED: должен найти (общий префикс отправ >= 5)");
