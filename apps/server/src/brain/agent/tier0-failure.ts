/**
 * Провал детерминированного tier0-запуска (ревью 2026-09-24, T-F5): «Открой дискорд» — ярлык Update.exe без
 * `--processStart` запускался и сразу завершался (`launch_failed`), а ход кончался фразой «Не вышло открыть
 * дискорд: не получилось» — ни причины, ни второй попытки. Модели отдавался только `not_found`.
 *
 * Теперь провал запуска ЛЮБОГО кода уходит модели вместе с причиной (служебная врезка в контекст хода), а
 * фраза без модели (фоновые/промотированные пути озвучивают voice как есть) НАЗЫВАЕТ причину. Чистые функции.
 */
import type { LocalIntent } from "../router/index.js";
import { failurePhrase } from "../verbalize/action-phrases.js";

/** Причина провала запуска — по-человечески, из кода и текста клиента (app-resolve LaunchError: `reason=…`). */
export function launchFailureReason(code: string | undefined, message: string | undefined): string | undefined {
  const m = (message ?? "").toLowerCase();
  if (/process-exited-immediately/.test(m)) return "программа запустилась и сразу закрылась";
  if (/no-process|process-not-appeared/.test(m)) return "процесс программы так и не появился";
  if (/uninstaller-blocked/.test(m)) return "нашёлся только деинсталлятор — его я не запускаю";
  if (/steam-not-confirmed|steam-appid-stale/.test(m)) return "Steam не подтвердил запуск игры";
  if (/лаунчер не ответил/.test(m)) return "лаунчер не ответил вовремя";
  if (code === "not_found") return "не нашёл такую программу";
  if (code === "timeout") return "не дождался ответа — могла и запуститься, проверю";
  if (code === "disconnected" || code === "channel_down") return "связь с компьютером прервалась";
  if (code === "overlay_drawing") return undefined; // у failurePhrase своя точная формулировка
  // Незнакомая причина: берём текст клиента без префикса «не удалось запустить «x»:», коротко.
  const tail = (message ?? "").replace(/^.*?:\s*/u, "").replace(/[<>]/g, "").trim();
  return tail ? tail.slice(0, 100) : undefined;
}

/** Фраза провала без модели: для запуска — с причиной; прочее — прежняя формулировка. */
export function tier0FailureVoice(intent: LocalIntent, code: string | undefined, message: string | undefined): string {
  if (intent.kind !== "app.launch") return failurePhrase(intent, code);
  const reason = launchFailureReason(code, message);
  return reason ? `Не смог запустить ${intent.app}: ${reason}.` : failurePhrase(intent, code);
}

/** Служебная врезка для модели: быстрый путь не справился — что именно случилось и как не наломать дров. */
export function tier0FallbackNote(intent: LocalIntent, code: string | undefined, message: string | undefined): string {
  const what = intent.kind === "app.launch" ? `запуск «${intent.app}»` : `действие ${intent.kind}`;
  const detail = (message ?? "").replace(/[<>]/g, "").trim().slice(0, 240);
  const uncertain =
    code === "timeout"
      ? " Исход НЕИЗВЕСТЕН (таймаут): сначала сверь окна (window_list), повторный запуск вслепую запрещён."
      : "";
  return (
    `[Служебно, не реплика владельца: быстрый ${what} без модели не удался — код ${code ?? "неизвестен"}` +
    `${detail ? `, клиент сообщил: «${detail}»` : ""}. Это не приговор: доведи просьбу сама (канал программы — ` +
    `app_channels, другой ярлык/URI, веб-версия, code_run) и сверь результат.${uncertain} Владельцу провал ещё НЕ озвучен.]`
  );
}
