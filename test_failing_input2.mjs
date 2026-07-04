// ИСПРАВЛЕННАЯ версия с логикой минимум 2 попадания

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
  const RECALL_MIN_SCORE = 0.34;
  for (const s of skills) {
    const targets = [...new Set(skillTokens(`${s.name} ${s.when}`))];
    console.log(`Skill "${s.name}": targets =`, targets);
    if (targets.length === 0) continue;
    let hits = 0;
    for (const t of targets) {
      const hit = tokenHit(q, t);
      if (hit) hits++;
    }
    const score = hits / Math.min(q.size, targets.length);
    console.log(`  Hits: ${hits}, Score: ${score.toFixed(2)}`);
    // ЛОГИКА: требует МИНИМУМ 2 попадания И score >= RECALL_MIN_SCORE
    if (hits >= 2 && (score > bestScore || (score === bestScore && best !== null && s.id < best.id))) {
      best = s;
      bestScore = score;
    }
  }
  console.log(`Best: ${best ? best.id : "null"}, bestScore=${bestScore.toFixed(2)}, threshold hits>=2 && score>=${RECALL_MIN_SCORE}`);
  return bestScore >= RECALL_MIN_SCORE ? best : null;
}

// TEST CASE 1: Синоним отправить/пришли + файл
console.log("\n=== TEST 1: пришли файлик → Отправь файл ===");
const skill1 = [
  { id: "send_file", name: "Отправь файл", when: "когда нужно отправить файл" },
];
const result1 = matchLearnedSkill("пришли файлик", skill1);
console.log("Result:", result1 ? result1.id : "null");
console.log("ANALYSIS: 'файлик' (4 букв) vs 'файл' (4 букв): prefixLen=4, need=5 → MISS");
console.log("           'пришли' vs 'отправь'/'отправить': prefixLen=0 → MISS");
console.log("           ИТОГ: 0 hits → НЕ ПРОХОДИТ порог >=2");

// TEST CASE 2: модификация — добавим третий token в query  
console.log("\n=== TEST 2: пришли файл в телеграм → Отправь файл ===");
const result2 = matchLearnedSkill("пришли файл в телеграм", skill1);
console.log("Result:", result2 ? result2.id : "null");
console.log("ANALYSIS: 'файл' (точное совпадение) → HIT; 'пришли' → MISS; 'телеграм' vs навык → MISS");
console.log("           ИТОГ: 1 hit → НЕ ПРОХОДИТ порог >=2");

// TEST CASE 3: морфология которая РАБОТАЕТ
console.log("\n=== TEST 3: отправь → отправить (должно работать) ===");
const skill3 = [
  { id: "send", name: "Отправить", when: "когда отправить сообщение" },
];
const result3 = matchLearnedSkill("отправь", skill3);
console.log("Result:", result3 ? result3.id : "null");
console.log("ANALYSIS: 'отправь' (7) vs 'отправить' (9): prefixLen=7, need=5 → HIT");
console.log("          'отправь' vs 'когда' → MISS; vs 'сообщение' → MISS");
console.log("           ИТОГ: 1 hit → НЕ ПРОХОДИТ порог >=2 → NULL");
console.log("ВЫВОД: Даже морфологический матч падает на пороге 2-попаданий!!!");

// TEST CASE 4: два слова в query, оба матчат
console.log("\n=== TEST 4: отправить сообщение → Отправить когда отправить сообщение ===");
const skill4 = [
  { id: "send", name: "Отправить", when: "когда отправить сообщение" },
];
const result4 = matchLearnedSkill("отправить сообщение", skill4);
console.log("Result:", result4 ? result4.id : "null");
