/**
 * Проверка РЕЗЕРВНОГО канала мозга (подписка Claude Max через Agent SDK) — волна G.
 *
 * Зачем отдельный скрипт: убедиться, что подписка реально отвечает, НЕ поднимая весь сервер и не
 * дожидаясь исчерпания API-ключа. Печатает либо ответ модели, либо ЧЕСТНУЮ причину отказа.
 *
 *   node _jarvis_subscription_check.mjs
 *
 * Секрет не печатается: показывается только СПОСОБ авторизации (токен / сохранённый логин).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// .env читаем сами (скрипт вне сервера): нужен только CLAUDE_CODE_OAUTH_TOKEN, если он там есть.
try {
  const envFile = join(process.cwd(), ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
      if (m && !process.env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = m[1].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* .env может отсутствовать — не фатально */
}

const home = process.env.USERPROFILE || process.env.HOME || "";
const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
const hasLogin = home ? existsSync(join(home, ".claude", ".credentials.json")) : false;
const mode = hasToken ? "токен из .env (надёжный путь)" : hasLogin ? "сохранённый логин Claude Code" : "НЕТ";

console.log(`Авторизация подписки: ${mode}`);
if (!hasToken && !hasLogin) {
  console.log("Резерв недоступен. Сделайте одно из двух:");
  console.log("  1) claude setup-token   → полученный токен в .env как CLAUDE_CODE_OAUTH_TOKEN=…");
  console.log("  2) claude               → /login  (проще, но сессия может протухнуть)");
  process.exit(1);
}

// SDK живёт в apps/server (там же, где сервер) — резолвим оттуда, чтобы скрипт работал из корня репо.
const { createRequire } = await import("node:module");
const { pathToFileURL } = await import("node:url");
let query;
try {
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
} catch {
  const req = createRequire(pathToFileURL(join(process.cwd(), "apps", "server", "package.json")));
  ({ query } = await import(pathToFileURL(req.resolve("@anthropic-ai/claude-agent-sdk")).href));
}
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY; // ключ побеждает подписку в порядке кредов SDK — резерв идёт мимо него

const t0 = Date.now();
try {
  let answer = "";
  for await (const msg of query({
    prompt: "Ответь ровно одной короткой фразой по-русски: резерв на подписке работает.",
    options: { systemPrompt: "Ты проверочный echo-ассистент. Отвечай одной фразой.", tools: [], model: "sonnet", maxTurns: 1, env },
  })) {
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) if (b.type === "text") answer += b.text;
    }
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(String(msg.result ?? msg.subtype));
      const u = msg.usage ?? {};
      console.log(`Токены: вход ${u.input_tokens ?? 0}, выход ${u.output_tokens ?? 0}`);
    }
  }
  console.log(`Ответ модели: ${answer.trim() || "(пусто)"}`);
  console.log(`ГОТОВО за ${Date.now() - t0} мс — резерв по подписке РАБОТАЕТ.`);
} catch (e) {
  console.log(`НЕ РАБОТАЕТ: ${e instanceof Error ? e.message : String(e)}`);
  console.log("Если это ошибка авторизации — обновите вход: `claude setup-token` (надёжнее) или `claude` → /login.");
  process.exit(2);
}
