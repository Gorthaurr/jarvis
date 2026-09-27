/**
 * W2 (пакет 0): БУФЕР НАБРАННОГО в пределах «эпохи фокуса» — каркас для рубежей П1/П2.
 *
 * Зачем: (§0, П2) номер карты, набранный по кускам («4276 1600» + « 1234 5678», поцифровые key, шаги батча), Луна на
 * каждый вызов отдельно не видит — видит по `digits(40)`; (§14, П1) владелец в вопросе должен увидеть, ЧТО уйдёт по
 * Enter, — `recent(200)` становится `needsApproval.pendingText`.
 * Эпоха фокуса, а не hwnd: печатные клавиши не должны требовать `window.list`. Сбрасывают эпоху (П2 проводит в
 * secret-memory.ts, по факту инжекции): клавиша, уводящая из поля (Enter, Tab, Esc, Alt/Win, F-клавиши; правка и
 * навигация ВНУТРИ поля — нет), click/invoke, смена окна (window.focus на другое окно, app.launch), ввод владельца,
 * пауза > 10 с.
 */

/** Сколько символов текста держим (для pendingText хватает 200; запас — на склейку кусков). */
const TEXT_CAP = 400;
/** Проекция для Луны: только цифры и типовые разделители номера карты. */
const DIGIT_SEP_RE = /[\d \t\-.,/ ]/u;

export class InputBuffer {
  private text = "";
  private digitTrail = "";
  private epochNo = 0;
  private lastAt = 0;

  /** Дописать напечатанное (текст целиком; цифры и разделители — в проекцию для Луны). */
  append(s: string, now = Date.now()): void {
    if (!s) return;
    this.text = (this.text + s).slice(-TEXT_CAP);
    for (const ch of s) this.digitTrail = DIGIT_SEP_RE.test(ch) ? this.digitTrail + ch : "";
    this.digitTrail = this.digitTrail.slice(-TEXT_CAP);
    this.lastAt = now;
  }

  /** Забой: последний символ стёрт и из текста, и из хвоста цифр (поле то же — эпоха прежняя). */
  backspace(): void {
    this.text = this.text.slice(0, -1);
    this.digitTrail = this.digitTrail.slice(0, -1);
  }

  /** Новая эпоха фокуса: всё набранное забыто. */
  reset(): void {
    this.text = "";
    this.digitTrail = "";
    this.epochNo += 1;
  }

  /** В эпохе ничего не набрано. */
  get empty(): boolean {
    return this.text === "";
  }

  /** Последние n символов набранного (для pendingText вопроса владельцу). */
  recent(n = 200): string {
    return this.text.slice(-n);
  }

  /** Хвост цифр и разделителей подряд (≤ n) — вход Луны по склейке кусков. Буква рвёт хвост. */
  digits(n = 40): string {
    return this.digitTrail.slice(-n);
  }

  get epoch(): number {
    return this.epochNo;
  }

  /** Когда печатали последний раз (0 — не печатали) — П2 сбрасывает эпоху по паузе. */
  get lastAppendAt(): number {
    return this.lastAt;
  }
}

/** Буфер процесса клиента (ввод один — буфер один). */
export const inputBuffer = new InputBuffer();
