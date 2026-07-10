/**
 * Рабочая (краткосрочная) память сессии (§8, §10).
 *
 * Две структуры, обе живут в памяти процесса (реально, не стаб):
 *  1. Кольцевой буфер реплик — последние N ходов диалога для контекста LLM (§8).
 *  2. Стек сущностей — для разрешения анафоры/дейксиса «он/это/там» (§10):
 *     последние упомянутые объекты, к которым может относиться местоимение.
 */

/** Реплика диалога в буфере. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** Сущность для анафоры (§10): объект, на который можно сослаться местоимением. */
export interface Entity {
  /** Машинный тип: "app" | "file" | "person" | "message" | "url" | ... */
  type: string;
  /** Человекочитаемое имя/значение («Notion», «отчёт.pdf», «Аня»). */
  label: string;
  /** Опциональная привязка (handle окна, путь, id). */
  ref?: string;
  ts: number;
}

export class WorkingMemory {
  private readonly turns: Turn[] = [];
  private readonly entities: Entity[] = [];

  constructor(
    /** Сколько последних реплик держать (кольцо). Больше окно → дольше помнит задачу для «сделал?». */
    private readonly maxTurns = 40,
    /** Сколько последних сущностей держать в стеке анафоры. */
    private readonly maxEntities = 12,
    /** Колбэк на любое изменение (для персиста на диск §5) — дебаунсит вызывающий. */
    private onChange?: () => void,
  ) {}

  /** Назначить колбэк персиста (если не задан в конструкторе). */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Сериализовать для персиста на диск (контекст переживает рестарт сервера/клиента, §5). */
  toJSON(): { turns: Turn[]; entities: Entity[] } {
    return { turns: [...this.turns], entities: [...this.entities] };
  }

  /** Восстановить из персиста (новейшие в пределах кольца). НЕ дёргает onChange. */
  restore(data: { turns?: Turn[]; entities?: Entity[] } | null | undefined): void {
    if (!data) return;
    if (Array.isArray(data.turns)) {
      this.turns.length = 0;
      this.turns.push(...data.turns.slice(-this.maxTurns));
    }
    if (Array.isArray(data.entities)) {
      this.entities.length = 0;
      this.entities.push(...data.entities.slice(-this.maxEntities));
    }
  }

  /** Добавить реплику; старые вытесняются (кольцевой буфер). */
  pushTurn(role: Turn["role"], text: string): void {
    this.turns.push({ role, text, ts: Date.now() });
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
    this.onChange?.();
  }

  /** Последние реплики (по возрастанию времени) — контекст для LLM (§8). */
  recentTurns(limit = this.maxTurns): readonly Turn[] {
    return this.turns.slice(-limit);
  }

  /**
   * Зарегистрировать упомянутую сущность (вершина стека анафоры, §10).
   * Если такая уже есть — поднимаем наверх (обновляем ts), не дублируем.
   */
  pushEntity(entity: Omit<Entity, "ts">): void {
    const idx = this.entities.findIndex(
      (e) => e.type === entity.type && e.label === entity.label,
    );
    if (idx >= 0) this.entities.splice(idx, 1);
    this.entities.push({ ...entity, ts: Date.now() });
    if (this.entities.length > this.maxEntities) {
      this.entities.splice(0, this.entities.length - this.maxEntities);
    }
    this.onChange?.();
  }

  /**
   * Разрешить анафору: вернуть самую свежую сущность (опц. заданного типа).
   * «открой его» → последняя сущность; «открой файл» → последняя type==="file".
   */
  resolveAnaphora(type?: string): Entity | undefined {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i]!;
      if (!type || e.type === type) return e;
    }
    return undefined;
  }

  /** Стек сущностей сверху вниз (свежие первыми) — для отладки/LLM. */
  entityStack(): readonly Entity[] {
    return [...this.entities].reverse();
  }

  /** Очистить (новая тема/сессия). */
  clear(): void {
    this.turns.length = 0;
    this.entities.length = 0;
  }
}
