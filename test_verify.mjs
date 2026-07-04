function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Проверим: прислать vs пришли
console.log("'прислать' (8) vs 'пришли' (6):");
console.log("  commonPrefixLen =", commonPrefixLen("прислать", "пришли"));
console.log("  need = max(5, ceil(0.75*min(8,6))) = max(5, ceil(4.5)) = max(5, 5) = 5");
console.log("  prefixLen=4 >= need=5? false");
console.log("\nА может в test морфология обработана по-другому? Проверим skillTokens:");

function skillTokens(s) {
  const norm = s.toLowerCase().replace(/ё/g, "е");
  return (norm.match(/[a-zа-я0-9]+/gu) ?? []).filter((w) => w.length >= 4);
}

const query = "пришли отчёт в телеграм";
const when = "прислать отчёт в телеграм";
console.log("\nQuery tokens:", skillTokens(query));
console.log("When tokens:", skillTokens(when));
console.log("Name+when tokens:", skillTokens(`Отчёт в Telegram ${when}`));
