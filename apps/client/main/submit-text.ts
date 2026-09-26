/**
 * Текст из чата renderer → мозг (боевой прогон 2026-09-26).
 *
 * Раньше main сначала гонял фразу через свой клиентский tier0 (регэксп времён M0): «открой блокнот и напиши в нём:
 * привет» он забирал как запуск программы «блокнот и напиши в нём: привет» → not-found, и до модели фраза НЕ доходила
 * вовсе (ни отката, ни ответа в чате — только карточка «Ошибка»). Серверный tier0 делает то же за те же $0, но знает
 * алиасы, отдаёт фразу-инструкцию модели и откатывается в модель на not-found. Второй, глупый tier0 на клиенте — лишний
 * (DRY): набранный текст идёт на сервер ВСЕГДА, как голос. Нет связи — честно говорим, что фраза не ушла.
 */
import type { ClientState } from "@jarvis/protocol";

export interface SubmitTextDeps {
  /** Отправить dev.text; false — сокет не открыт, фраза НЕ ушла. */
  send: (text: string) => boolean;
  setState: (state: ClientState) => void;
  notify: (title: string, markdown: string) => void;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export function submitTypedText(text: string, deps: SubmitTextDeps): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  deps.log.info(`ввод пользователя: "${trimmed}"`);
  deps.setState("thinking");
  // state вернётся в idle по приходу ответа/transcript от сервера.
  if (deps.send(trimmed)) return;
  deps.log.warn("нет соединения с сервером — фраза из чата не отправлена");
  deps.notify("Нет связи с сервером", "Фраза **не отправлена**: клиент сейчас не подключён к мозгу. Повторите, когда статус станет online.");
  deps.setState("idle");
}
