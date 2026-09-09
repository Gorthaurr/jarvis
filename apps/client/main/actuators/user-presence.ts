/**
 * «Активен ли пользователь СЕЙЧАС» — чистая логика, отделённая от Electron (§ «не мешать»).
 *
 * Зачем отдельно: гейт физического ввода (мышь/клавиатура) не должен мешать активному пользователю,
 * но сигнал простоя приходит из Electron `powerMonitor.getSystemIdleTime()`. Чтобы решение
 * тестировалось без среды — вся арифметика тут, а актуатор лишь подставляет реальные значения.
 *
 * Тонкость: системный idle сбрасывает ЛЮБОЙ ввод, в т.ч. SendInput самого Джарвиса. Поэтому «недавний
 * ввод» считаем активностью ПОЛЬЗОВАТЕЛЯ только если он произошёл ПОЗЖЕ последнего ввода Джарвиса.
 */
export interface PresenceInput {
  /** Системное время простоя, мс (с последнего ввода любого источника). */
  idleMs: number;
  /** Когда Джарвис последний раз сам инжектил ввод (Date.now-мс); 0 — никогда. */
  lastJarvisInputAt: number;
  /** Текущее время (Date.now-мс). */
  now: number;
  /** Простой ≥ этого — пользователь не активен (отошёл/не трогает ввод). */
  thresholdMs?: number;
  /** Запас на лаг SendInput→idle: ввод в пределах этого после нашего считаем «нашим». */
  toleranceMs?: number;
}

export function isUserActive({
  idleMs,
  lastJarvisInputAt,
  now,
  thresholdMs = 4000,
  toleranceMs = 900,
}: PresenceInput): boolean {
  if (idleMs >= thresholdMs) return false; // давно никто не вводил → пользователь не активен
  const lastInputAt = now - idleMs; // момент последнего ввода (любого)
  // Ввод ПОЗЖЕ нашего последнего (с запасом) → это пользователь. Иначе — это был сам Джарвис.
  return lastInputAt - lastJarvisInputAt > toleranceMs;
}

/**
 * ПРИСУТСТВИЕ ВЛАДЕЛЬЦА для доверенного снимка ПК (разбор эпизода «Дота», 2026-09-02, HIGH).
 *
 * 🔴 Зачем отдельно от `isUserActive`: снимок окружения уходит в промпт КАЖДЫЕ 12 секунд строкой
 * «Пользователь: за ПК / отошёл», и считался он по СЫРОМУ системному простою. Но системный idle
 * сбрасывает ЛЮБОЙ ввод — включая SendInput самого Джарвиса. В живом эпизоде он кликал каждые 6-21 с,
 * то есть во время ЛЮБОЙ GUI-задачи снимок систематически утверждал «владелец за ПК», даже если того
 * не было в комнате. Модель читала это как факт и объясняла им свои неудачи («ввод мне не отдают — вы
 * за компьютером») — выдумка, опирающаяся на нашу же неправду в промпте.
 *
 * Правило: ввод считается ВЛАДЕЛЬЦЕВЫМ, только если он позже нашего последнего (с запасом на лаг).
 * Если последний ввод — наш, а владельцевого мы ещё не видели, честный ответ — «не знаю», а не «за ПК»:
 * утверждать присутствие человека по собственному клику — ровно то же, что «Готово» без проверки.
 */
export interface OwnerPresenceInput {
  /** Системное время простоя, мс. */
  idleMs: number;
  /** Когда Джарвис последний раз сам инжектил ввод (Date.now-мс); 0 — никогда. */
  lastJarvisInputAt: number;
  /** Последний ввод, признанный ВЛАДЕЛЬЦЕВЫМ (Date.now-мс); 0 — ещё не видели. */
  lastUserInputAt: number;
  now: number;
  /** Простой владельца ≥ этого — «отошёл». Снимок мыслит минутами, а не секундами гейта ввода. */
  awayThresholdMs?: number;
  /** Запас на лаг SendInput→idle: ввод в пределах этого после нашего считаем НАШИМ. */
  toleranceMs?: number;
}

export interface OwnerPresenceResult {
  /** at_pc — владелец недавно вводил сам; away — давно; unknown — последний ввод наш, о нём судить нельзя. */
  state: "at_pc" | "away" | "unknown";
  /** Простой ВЛАДЕЛЬЦА, мс (для unknown — 0: величина неизвестна, а не ноль). */
  idleMs: number;
  /** Обновлённая отметка владельцевого ввода — вызывающий её сохраняет. */
  lastUserInputAt: number;
}

export function ownerPresence({
  idleMs,
  lastJarvisInputAt,
  lastUserInputAt,
  now,
  awayThresholdMs = 60_000,
  toleranceMs = 900,
}: OwnerPresenceInput): OwnerPresenceResult {
  const lastInputAt = now - idleMs; // момент последнего ввода (любого источника)
  const ours = lastJarvisInputAt > 0 && lastInputAt - lastJarvisInputAt <= toleranceMs;
  const seenUserAt = ours ? lastUserInputAt : Math.max(lastUserInputAt, lastInputAt);
  if (seenUserAt <= 0) return { state: "unknown", idleMs: 0, lastUserInputAt: seenUserAt };
  const userIdle = Math.max(0, now - seenUserAt);
  return { state: userIdle < awayThresholdMs ? "at_pc" : "away", idleMs: userIdle, lastUserInputAt: seenUserAt };
}
