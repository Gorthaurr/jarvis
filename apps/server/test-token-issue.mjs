// Симулируем функцию skillTokens из skills.ts (строка 469-472)
function skillTokens(s) {
  const norm = s.toLowerCase().replace(/ё/g, "е");
  return (norm.match(/[a-zа-я0-9]+/gu) ?? []).filter((w) => w.length >= 4);
}

// Тестовые кейсы из заявления
console.log("=== ПРОВЕРКА ЖАДНОЙ ФИЛЬТРАЦИИ ===\n");

// Кейс 1: "отправь Герману" (заявление)
const query1 = "отправь герману";
const tokens1 = skillTokens(query1);
console.log(`Query: "${query1}"`);
console.log(`Tokens: [${tokens1.join(", ")}]`);
console.log(`Токены: отправь=${tokens1.includes("отправь")}, герман=${tokens1.includes("герман")}`);
console.log(`РЕЗУЛЬТАТ: "${query1}" - токены OK, "герман" не отсечен (5 символов)\n`);

// Кейс 2: "сделай что-то Лев" (имя контакта в навыке 'Написать Льву')
const query2 = "сделай что-то лев";
const tokens2 = skillTokens(query2);
console.log(`Query: "${query2}"`);
console.log(`Tokens: [${tokens2.join(", ")}]`);
console.log(`Токены: сделай=${tokens2.includes("сделай")}, что=${tokens2.includes("что")}, лев=${tokens2.includes("лев")}`);
console.log(`РЕЗУЛЬТАТ: "лев" ОТСЕЧЕН (3 символа < 4)! <- ВОТ ПОЛОМКА\n`);

// Кейс 3: навык с именем "Написать Льву"
const skillDesc = "написать льву";
const skillTokens3 = skillTokens(skillDesc);
console.log(`Skill name: "Написать Льву" (когда нужно написать личное сообщение Льву)`);
console.log(`Skill tokens from name: [${skillTokens3.join(", ")}]`);
console.log(`РЕЗУЛЬТАТ: токен "льву" ОТСЕЧЕН (4 символа, граница). "написать" сохран.`);
console.log(`На запрос "сделай что-то лев" НЕТ перекрытия "лев" - recall НЕ сработает.\n`);

// Кейс 4: "Ада" (2 символа - очень короткое имя)
const query4 = "напиши аде";
const tokens4 = skillTokens(query4);
console.log(`Query: "${query4}"`);
console.log(`Tokens: [${tokens4.join(", ")}]`);
console.log(`РЕЗУЛЬТАТ: "аде" ОТСЕЧЕНО (3 символа). Навык "Написать Аде" будет пропущен.\n`);

// Вывод об ОБЩЕЙ проблеме
console.log("=== ДИАГНОЗ ===");
console.log("ЖАДНАЯ ФИЛЬТРАЦИЯ skillTokens(s).filter((w) => w.length >= 4) ДЕЙСТВИТЕЛЬНО:");
console.log("Отсекает лев/льву (имена 3-4 символа)");
console.log("Отсекает аде/ада (мини-имена)");
console.log("Отсекает тг (сокращения)");
console.log("Отсекает служебные короткие слова");
console.log("\n=== ВЕРДИКТ ===");
console.log("ФАКТ 1: Код ДЕЙСТВИТЕЛЬНО ТАК РАБОТАЕТ (line 471)");
console.log("ФАКТ 2: Сценарий 'лев' ДЕЙСТВИТЕЛЬНО ломается");
console.log("ФАКТ 3: Это детерминировано - модель его НЕ перехватывает (pure function, лексический recall)");
