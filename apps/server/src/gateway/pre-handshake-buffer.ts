/**
 * Буфер кадров, пришедших ПОКА async-handshake в полёте (P0 «речь теряется», аудит 2026-07-28).
 *
 * Раньше такие кадры молча игнорились (87% дневных warn; первая фраза владельца после рестарта/
 * reconnect пропадала — handshake занимает 3-5с на резолв БД/hydrate). Здесь — ЧИСТАЯ политика
 * буферизации (без ws/сессий), поэтому её поведение проверяется юнит-тестами:
 *   • кап по числу кадров И по РАЗМЕРУ СЫРЫХ ws-сообщений (буфер живёт ДО аутентификации,
 *     ws-дефолт maxPayload = 100 МиБ);
 *   • кадр толще всего капа отвергается СРАЗУ, ДО постановки в очередь — иначе он вытеснял бы
 *     весь накопленный буфер речи по одному и лишь потом отбрасывался сам (раунд-4 ревью);
 *   • переполнение вытесняет СТАРЕЙШИЕ (конец фразы ценнее её начала);
 *   • счётчик отброшенных не сбрасывается до drain() — потеря всегда видна в логе.
 */

/** Что случилось с кадром при постановке в буфер (вызывающий решает, что логировать). */
export interface PushOutcome {
  /** Кадр отвергнут как заведомо слишком жирный (в буфер не попал, накопленное цело). */
  rejectedOversize: boolean;
  /** Сколько РАНЕЕ накопленных кадров вытеснено этой постановкой. */
  evicted: number;
}

export class PreHandshakeBuffer<T> {
  private readonly items: Array<{ item: T; bytes: number }> = [];
  private bytes = 0;
  private dropped = 0;

  constructor(
    /** Кап по числу кадров (~6с аудио при 100 кадрах/с). */
    private readonly maxItems = 600,
    /** Кап по сумме размеров сырых сообщений. */
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  /** Поставить кадр в буфер. Возвращает, что с ним произошло (для честного WARN у вызывающего). */
  push(item: T, bytes: number): PushOutcome {
    if (bytes > this.maxBytes) {
      this.dropped += 1;
      return { rejectedOversize: true, evicted: 0 };
    }
    this.items.push({ item, bytes });
    this.bytes += bytes;
    let evicted = 0;
    while (this.items.length > this.maxItems || (this.bytes > this.maxBytes && this.items.length > 1)) {
      const out = this.items.shift();
      if (!out) break;
      this.bytes -= out.bytes;
      this.dropped += 1;
      evicted += 1;
    }
    return { rejectedOversize: false, evicted };
  }

  /** Забрать накопленное (буфер очищается). Счётчик отброшенных СОХРАНЯЕТСЯ — см. droppedCount. */
  drain(): T[] {
    const out = this.items.map((x) => x.item);
    this.items.length = 0;
    this.bytes = 0;
    return out;
  }

  /** Сколько кадров потеряно за всё время жизни буфера (для итогового WARN). */
  get droppedCount(): number {
    return this.dropped;
  }

  get size(): number {
    return this.items.length;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
