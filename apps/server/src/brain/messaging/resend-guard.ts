/**
 * Ресенд-гард (§14, эпизод «двойная отправка Кате» 2026-07-24): вторая отправка ТОМУ ЖЕ человеку
 * через секунды после первой — почти всегда не новое поручение, а гонка голосового UX: пользователь
 * договаривает мысль, пока задача №1 ещё летит/только что села, обрывок STT рождает задачу №2, и
 * модель повторяет отправку. Идемпотентность по точному тексту это НЕ ловила: достаточно другой
 * пунктуации/регистра/склонения имени («Катя»→«Кате») — ключ другой, дубль уходит человеку.
 *
 * Механика: короткое окно (JARVIS_RESEND_GUARD_MS, деф 2 мин) помнит ПОСЛЕДНЮЮ успешную отправку
 * per (userId, channel, адресат), где адресат — ВСЕ известные ключи идентичности (peerId из резолва
 * И свёрнутое имя). Новая отправка в окне:
 *  - тот же нормализованный текст → «identical» (повтор не уходит молча; явный повтор — через confirm);
 *  - похожий текст (overlap-коэффициент токенов) → «similar» (отправка только через confirm §14);
 *  - другой текст → пропускается (легитимное «вдогонку» с новым содержанием).
 * Чистая логика, время инъектируется (тестируемость). In-memory: окно короткое, рестарт его чистит.
 */
import { TtlCache, foldName, foldText } from "@jarvis/shared";

/** Запомненная недавняя отправка (значение окна). */
export interface RecentSend {
  /** Нормализованный текст (normalizeSendBody). */
  bodyNorm: string;
  /** Обрезанный исходный текст — для честной сводки confirm («только что отправлял: …»). */
  bodyPreview: string;
  /** unix ms успешной отправки. */
  at: number;
}

/** Вердикт гарда по новой отправке в окне. */
export interface ResendHit {
  kind: "identical" | "similar";
  prev: RecentSend;
  ageMs: number;
}

/**
 * Нормализация текста сообщения для сравнения «то же ли это сообщение»: регистр/ё/пунктуация/пробелы
 * сворачиваются (foldText). Текст ЦЕЛИКОМ из эмодзи/символов foldText выел бы в пусто — тогда
 * фолбэк на сырой trim+lowercase (иначе разные эмодзи-сообщения слиплись бы в один ключ).
 */
export function normalizeSendBody(text: string): string {
  const folded = foldText(String(text ?? ""));
  return folded || String(text ?? "").trim().toLowerCase();
}

/** Порог похожести: пересечение токенов / меньшая сторона. */
const SIMILAR_OVERLAP_MIN = 0.7;

/**
 * Похожи ли два НОРМАЛИЗОВАННЫХ текста (не идентичных): overlap-коэффициент токенов ≥ 0.7 и хотя бы
 * одно содержательное совпадение (токен ≥3 символов). «я люблю тебя» ≈ «люблю тебя ❤» → similar;
 * «приду в 8» vs «куплю хлеб» → нет (разное содержание — легитимная вторая отправка).
 */
export function similarSendBody(aNorm: string, bNorm: string): boolean {
  const a = new Set(aNorm.split(" ").filter(Boolean));
  const b = new Set(bNorm.split(" ").filter(Boolean));
  // Однословная сторона — только ТОЧНОЕ совпадение (identical-ветка гарда): min-знаменатель на
  // «привет» делал «похожим» ЛЮБОЕ последующее сообщение с этим словом → лишние confirm (ревью).
  if (a.size < 2 || b.size < 2) return false;
  let inter = 0;
  let contentHit = false;
  for (const t of a) {
    if (b.has(t)) {
      inter += 1;
      if (t.length >= 3) contentHit = true;
    }
  }
  return contentHit && inter / Math.min(a.size, b.size) >= SIMILAR_OVERLAP_MIN;
}

/** Окно гарда: env JARVIS_RESEND_GUARD_MS, деф 2 мин, 0 = выключен. */
export function resendGuardWindowMs(): number {
  const raw = Number(process.env.JARVIS_RESEND_GUARD_MS ?? 120_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
}

/**
 * Ключи идентичности адресата для гарда: точный peerId (когда резолв его знает) + свёрнутое имя +
 * СТЕМ имени (последняя гласная срезается: «катя»/«кате»/«катю» → «кат») — русское склонение имени
 * в голосе («напиши Кате» vs «Катя») не должно размыкать окно, даже когда peerId в памяти резолва
 * нет. Стем груб намеренно: ложное слияние двух разных людей лишь добавляет один confirm при
 * похожем тексте в 2-минутном окне — дёшево против необратимого дубля человеку.
 */
export function peerIdentityKeys(opts: { peerId?: string; names: readonly (string | undefined)[] }): string[] {
  const keys = new Set<string>();
  if (opts.peerId) keys.add(`peer:${opts.peerId}`);
  for (const n of opts.names) {
    const f = foldName(String(n ?? "")) || String(n ?? "").trim().toLowerCase();
    if (!f) continue;
    keys.add(`name:${f}`);
    if (f.length >= 4) keys.add(`stem:${f.replace(/[аеиоуыэюя]$/u, "")}`);
  }
  return [...keys];
}

export class ResendGuard {
  private readonly cache: TtlCache<RecentSend>;
  private readonly now: () => number;

  constructor(
    private readonly windowMs: number,
    now: () => number = () => Date.now(),
  ) {
    // ttl>0 обязателен для TtlCache; при выключенном гарде (0) кэш не используется (check/record no-op).
    this.cache = new TtlCache<RecentSend>({ ttlMs: Math.max(1, windowMs), maxEntries: 500, now });
    this.now = now;
  }

  private key(userId: string, channel: string, peerKey: string): string {
    return `${userId}|${channel}|${peerKey}`;
  }

  /**
   * Проверить новую отправку против окна. peerKeys — все известные ключи идентичности адресата
   * (напр. `peer:<peerId>`, `name:<foldName(to)>`); совпадение по ЛЮБОМУ означает «тот же человек».
   */
  check(userId: string, channel: string, peerKeys: readonly string[], body: string): ResendHit | undefined {
    if (this.windowMs <= 0) return undefined;
    const bodyNorm = normalizeSendBody(body);
    for (const pk of peerKeys) {
      const prev = this.cache.get(this.key(userId, channel, pk));
      if (!prev) continue;
      const ageMs = Math.max(0, this.now() - prev.at);
      if (prev.bodyNorm === bodyNorm) return { kind: "identical", prev, ageMs };
      if (similarSendBody(prev.bodyNorm, bodyNorm)) return { kind: "similar", prev, ageMs };
    }
    return undefined;
  }

  /** Зафиксировать УСПЕШНУЮ отправку под всеми ключами идентичности адресата. */
  record(userId: string, channel: string, peerKeys: readonly string[], body: string): void {
    if (this.windowMs <= 0) return;
    const entry: RecentSend = {
      bodyNorm: normalizeSendBody(body),
      bodyPreview: String(body ?? "").slice(0, 160),
      at: this.now(),
    };
    for (const pk of peerKeys) this.cache.set(this.key(userId, channel, pk), entry);
  }
}
