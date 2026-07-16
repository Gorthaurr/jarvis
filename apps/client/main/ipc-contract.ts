/**
 * Контракт IPC между main и renderer (§3, §21).
 *
 * Единственный источник правды для имён каналов и форм сообщений, импортируется
 * и в main (регистрация обработчиков), и в preload (contextBridge-мост), и в renderer
 * (типизация window.jarvis). renderer изолирован (contextIsolation) и НЕ имеет node —
 * всё общение через этот мост.
 */
import type {
  ClientState,
  Transcript,
  ProactiveNudge,
  ConfirmRequest,
  DisplayCard,
  TaskStatus,
  TaskControl,
  SkillSaved,
  VoiceEnrollProgress,
  VoiceEnrollDone,
  VoiceList,
  MonitorList,
  ChatMessage,
  UsageInfo,
} from "@jarvis/protocol";

/** Имена IPC-каналов. renderer -> main (invoke/send) и main -> renderer (события). */
export const IPC = {
  // renderer -> main
  submitText: "jarvis:submitText", // dev-текст из поля ввода (M0)
  confirmResult: "jarvis:confirmResult", // ответ на ConfirmRequest (§14)
  taskControl: "jarvis:taskControl", // управление задачей из UI (стоп/пауза, §20)
  pushPcm: "jarvis:pushPcm", // кадр PCM16 из renderer (захват, §3)
  playbackActive: "jarvis:playbackActive", // §10 идёт ли СЕЙЧАС воспроизведение TTS (для barge в хвосте)
  audioPlayed: "jarvis:audioPlayed", // realtime инкремент 0: первый звук хода реально сыгран (mouth-to-ear)
  activate: "jarvis:activate", // push-to-talk активация (когда нет wake word, §18)
  mute: "jarvis:mute", // честный mute (§0.6)
  skillStart: "jarvis:skillStart", // начать запись навыка демонстрацией (§8)
  skillStop: "jarvis:skillStop", // завершить запись и сохранить навык (§8)
  skillCancel: "jarvis:skillCancel", // отменить запись без сохранения (§8)
  skillRun: "jarvis:skillRun", // повторить ранее записанный навык (§8)
  voiceEnrollStart: "jarvis:voiceEnrollStart", // §3 начать запись голосового отпечатка
  voiceEnrollCancel: "jarvis:voiceEnrollCancel", // §3 отменить запись отпечатка
  voiceList: "jarvis:voiceList", // §3 запросить список голосов
  voiceRemove: "jarvis:voiceRemove", // §3 удалить голос по имени
  monitorList: "jarvis:monitorList", // §6 запросить список мониторов (мультимонитор)
  monitorAssign: "jarvis:monitorAssign", // §6 назначить рабочий монитор Джарвиса (index|null)
  settingsGet: "jarvis:settingsGet", // настройки: получить срез (invoke) — язык/контекст/флаги ключей
  settingsSave: "jarvis:settingsSave", // настройки: сохранить патч (invoke) — возвращает честный отчёт
  requestUsage: "jarvis:requestUsage", // §6B/B5 вкладка «Оплата»: запросить свежий расход/лимиты
  // main -> renderer (push-события)
  state: "jarvis:state", // смена ClientState (орб)
  transcript: "jarvis:transcript",
  chat: "jarvis:chat", // §22 реплика чата (роль+текст)
  speakChunk: "jarvis:speakChunk", // аудио-чанк TTS для воспроизведения (§10)
  micState: "jarvis:micState", // гейт микрофона открыт/закрыт (§10)
  bargeIn: "jarvis:bargeIn", // заглушить плеер TTS (barge-in §10)
  nudge: "jarvis:nudge",
  confirmRequest: "jarvis:confirmRequest",
  display: "jarvis:display", // карточка ui.display (§21)
  taskStatus: "jarvis:taskStatus", // прогресс задачи (§20)
  link: "jarvis:link", // online/offline индикатор связи
  skillState: "jarvis:skillState", // состояние записи навыка (запись/счётчик, §8)
  skillSaved: "jarvis:skillSaved", // навык записан/доступен для повтора (§8)
  voiceEnrollProgress: "jarvis:voiceEnrollProgress", // §3 % записи отпечатка
  voiceEnrollDone: "jarvis:voiceEnrollDone", // §3 отпечаток записан/нет
  voiceVoices: "jarvis:voiceVoices", // §3 список enrolled-голосов
  monitorInfo: "jarvis:monitorInfo", // §6 список мониторов + текущая настройка (для UI)
  usage: "jarvis:usage", // §6B/B5 расход/лимиты периода → вкладка «Оплата»
} as const;

/** Состояние записи навыка демонстрацией — для индикатора в UI (§8). */
export interface SkillRecState {
  recording: boolean;
  /** число пойманных значимых действий. */
  count: number;
  /** последнее действие (роль/имя) — для живого фидбэка. */
  last?: string;
  /** sidecar недоступен → запись невозможна (UIA-хук не поднять). */
  unavailable?: boolean;
}

/** Аудио-чанк TTS для renderer (audio — base64; в проде WebRTC, §5). */
export interface SpeakChunkPayload {
  audio: string;
  seq: number;
  last: boolean;
  /** §Волна3 (3.5): сырой PCM16-стрим v3 (иначе mp3). Пробрасывается raw от сервера. */
  format?: "pcm16";
  sampleRate?: number;
  /** Realtime инкремент 0: инвалидатор хода — рендерер эхом вернёт его в audioPlayed (mouth-to-ear). */
  gen?: number;
}

/** Полезная нагрузка ответа на подтверждение (§14, с полем revision). */
export interface ConfirmResultPayload {
  requestId: string;
  approved: boolean;
  /** «перепиши короче» -> перегенерация (§14 revise-петля). */
  revision?: string;
}

/** Состояние связи для индикатора. */
export interface LinkState {
  online: boolean;
}

/** Имена API-ключей (вкладка «Ключи»). */
export type KeyName = "anthropic" | "eleven" | "deepgram";

/** Срез настроек для UI: язык/контекст + факт наличия ключей (секреты в renderer не возвращаем). */
export interface SettingsSnapshot {
  language: string;
  context: string;
  keys: Record<KeyName, boolean>;
}

/** Патч из UI: пустой/отсутствующий ключ = «оставить прежний» (поле ключа в UI всегда пустое). */
export interface SettingsPatch {
  language?: string;
  context?: string;
  keys?: Partial<Record<KeyName, string>>;
}

/** Честный отчёт о сохранении настроек (без ложного успеха). */
export interface SettingsSaveResult {
  ok: boolean;
  encryptionAvailable: boolean;
  /** какие ключи реально перезаписаны. */
  keysStored: KeyName[];
  /** ключ передан, но не сохранён (нет ОС-шифрования). */
  keysSkipped: boolean;
  error?: string;
}

/**
 * API, которое preload выставляет в renderer как window.jarvis.
 * Каждая подписка возвращает функцию-отписку.
 */
export interface JarvisBridge {
  /** Отправить dev-текст (M0 поток §17). */
  submitText(text: string): void;
  /** Ответить на запрос подтверждения (§14). */
  sendConfirmResult(payload: ConfirmResultPayload): void;
  /** Управление задачей из UI (§20): «стоп»/«пауза»/«продолжить». */
  sendTaskControl(action: TaskControl["action"], taskId?: string): void;
  /** Передать кадр PCM16 из захвата renderer в main (§3). */
  pushPcm(pcm: ArrayBuffer): void;
  /** §10 Сообщить main, идёт ли СЕЙЧАС воспроизведение TTS (чтобы перебивать и в «хвосте» очереди). */
  setPlaybackActive(active: boolean): void;
  /** Realtime инкремент 0: рендерер начал ВОСПРОИЗВЕДЕНИЕ первого звука хода gen в момент ts (Date.now). */
  audioPlayed(gen: number, ts: number): void;
  /** Push-to-talk активация микрофона (§18). */
  activate(): void;
  /** Честный mute (§0.6). */
  mute(): void;
  /** Начать запись навыка демонстрацией (§8). */
  startSkill(name: string): void;
  /** Завершить запись и сохранить навык (§8). */
  stopSkill(): void;
  /** Отменить запись без сохранения (§8). */
  cancelSkill(): void;
  /** Повторить ранее записанный навык по id (§8). */
  runSkill(id: string): void;
  /** §3 начать запись голосового отпечатка под именем (далее говорить ~enrollSeconds). */
  startVoiceEnroll(name: string): void;
  /** §3 отменить запись отпечатка. */
  cancelVoiceEnroll(): void;
  /** §3 запросить список enrolled-голосов. */
  listVoices(): void;
  /** §3 удалить голос по имени. */
  removeVoice(name: string): void;
  /** §6 запросить список мониторов (мультимонитор). */
  listMonitors(): void;
  /** §6 назначить рабочий монитор Джарвиса по индексу (null = авто/вторичный). */
  assignMonitor(index: number | null): void;
  /** Настройки: получить срез (язык/контекст/флаги ключей) для предзаполнения формы. */
  getSettings(): Promise<SettingsSnapshot>;
  /** Настройки: сохранить патч; резолвится честным отчётом (что записано, нужно ли шифрование). */
  saveSettings(patch: SettingsPatch): Promise<SettingsSaveResult>;
  /** §6B/B5: запросить свежий расход/лимиты для вкладки «Оплата». */
  requestUsage(): void;
  // подписки на события main -> renderer
  onState(cb: (state: ClientState) => void): () => void;
  onTranscript(cb: (t: Transcript) => void): () => void;
  /** §22 реплика чата (роль+текст) — для чат-вкладки и текстового фидбэка при mute. */
  onChat(cb: (m: ChatMessage) => void): () => void;
  onSpeakChunk(cb: (c: SpeakChunkPayload) => void): () => void;
  onMicState(cb: (open: boolean) => void): () => void;
  onBargeIn(cb: () => void): () => void;
  onNudge(cb: (n: ProactiveNudge) => void): () => void;
  onConfirmRequest(cb: (r: ConfirmRequest) => void): () => void;
  onDisplay(cb: (c: DisplayCard) => void): () => void;
  onTaskStatus(cb: (s: TaskStatus) => void): () => void;
  onLink(cb: (l: LinkState) => void): () => void;
  /** Состояние записи навыка (§8). */
  onSkillState(cb: (s: SkillRecState) => void): () => void;
  /** Навык записан/доступен для повтора (§8). */
  onSkillSaved(cb: (s: SkillSaved) => void): () => void;
  /** §3 прогресс записи голосового отпечатка (0..1). */
  onVoiceEnrollProgress(cb: (p: VoiceEnrollProgress) => void): () => void;
  /** §3 запись отпечатка завершена. */
  onVoiceEnrollDone(cb: (d: VoiceEnrollDone) => void): () => void;
  /** §3 текущий список enrolled-голосов. */
  onVoiceList(cb: (l: VoiceList) => void): () => void;
  /** §6 список мониторов + текущая настройка рабочего монитора. */
  onMonitors(cb: (l: MonitorList) => void): () => void;
  /** §6B/B5: расход/лимиты периода для вкладки «Оплата». */
  onUsage(cb: (u: UsageInfo) => void): () => void;
}
