/**
 * Пофразный аккумулятор для token-streaming TTS (§10 realtime).
 *
 * Из ПОТОКА текстовых дельт LLM собирает законченные ПРЕДЛОЖЕНИЯ и отдаёт их по мере
 * готовности — так первый звук = синтез ПЕРВОГО предложения, а не всей реплики. Граница —
 * `.!?…`/перенос строки. Текст к этому моменту уже нормализован под произношение (числа→слова,
 * markdown снят — §21 verbalize), поэтому десятичные точки редки; на всякий случай точка между
 * цифрами границей НЕ считается. Фрагмент без буквенно-цифрового содержимого (одна пунктуация)
 * не эмитится — копится дальше, чтобы не синтезировать «.» отдельным звуком.
 */

const WORD_CHAR = /[A-Za-zА-Яа-яЁё0-9]/;
const TERMINATOR = /[.!?…]/;
/** Закрывающая пунктуация, «прилипающая» к концу предложения (кавычки/скобки). */
const TRAILER = /[.!?…»"”'’)\]]/;

/**
 * Стримовый чанкер: дельты входят через push(), законченные предложения выходят сразу.
 * Незавершённый хвост держится в буфере до следующей дельты или flush().
 */
export class SentenceChunker {
  private buf = "";

  /** Подать дельту; вернуть готовые предложения (0..N), оставив незавершённый хвост в буфере. */
  push(delta: string): string[] {
    this.buf += delta;
    return this.drain();
  }

  /** Завершить поток: вернуть оставшийся хвост как предложение (если в нём есть содержимое). */
  flush(): string[] {
    const out = this.drain();
    const rest = this.buf.trim();
    this.buf = "";
    if (rest && WORD_CHAR.test(rest)) out.push(rest);
    return out;
  }

  /** Есть ли непустой (с буквами/цифрами) незавершённый хвост. */
  get hasPending(): boolean {
    return WORD_CHAR.test(this.buf);
  }

  private drain(): string[] {
    const out: string[] = [];
    for (;;) {
      const end = this.nextBoundary();
      if (end === -1) break;
      const piece = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, "");
      // Только пунктуация/пробел перед границей (нет слова) — не отдельный звук, копим дальше.
      if (piece && WORD_CHAR.test(piece)) out.push(piece);
    }
    return out;
  }

  /** Индекс ПОСЛЕ конца ближайшего законченного предложения в буфере, либо -1. */
  private nextBoundary(): number {
    for (let i = 0; i < this.buf.length; i += 1) {
      const c = this.buf[i]!;
      if (c === "\n") return i + 1;
      if (TERMINATOR.test(c)) {
        // Десятичная точка после цифры — не граница (на случай ненормализованного числа).
        if (c === "." && i > 0 && /\d/.test(this.buf[i - 1]!)) {
          // «.» — ПОСЛЕДНИЙ символ буфера: следующая цифра может прийти отдельной дельтой стрима
          // («3.» затем «14»). НЕ коммитим границу — ждём следующей дельты (flush() финализирует
          // хвост сам, так что «5.» в конце реплики не потеряется).
          if (i + 1 >= this.buf.length) return -1;
          // цифра.цифра — десятичная дробь, не конец предложения.
          if (/\d/.test(this.buf[i + 1]!)) continue;
        }
        // Проглотить набегающие терминаторы и закрывающую пунктуацию («?!», «...»», и т.п.).
        let j = i + 1;
        while (j < this.buf.length && TRAILER.test(this.buf[j]!)) j += 1;
        return j;
      }
    }
    return -1;
  }
}

/** Разбить готовый текст на предложения (нестримовый помощник; та же логика, что и чанкер). */
export function splitIntoSentences(text: string): string[] {
  const chunker = new SentenceChunker();
  const out = chunker.push(text);
  out.push(...chunker.flush());
  return out;
}
