/**
 * Машина состояний голосового цикла (§10).
 *
 * Чистый редьюсер: (context, event) → {context, actions}. Никаких побочных
 * эффектов — их выполняет VoicePipeline. Это делает поведение «живого собеседника»
 * (barge-in, follow-up окно, переходы idle↔listening↔thinking↔speaking) тестируемым.
 *
 * Состояния:
 *   idle      — ждём wake word; аудио на сервер НЕ идёт (§0.6 privacy-инвариант).
 *   listening — захват речи (после wake word или в follow-up окне §10).
 *   thinking  — речь финализирована, работает brain (agent).
 *   speaking  — стримим TTS; микрофон ГОРЯЧИЙ (full-duplex), ждём barge-in.
 */

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export type VoiceEvent =
  | { type: "wake" } // wake word (из idle)
  | { type: "speech_start" } // VAD: начало речи
  | { type: "speech_end" } // VAD: конец речи (эндпоинт-кандидат)
  | { type: "transcript_final"; text: string } // STT финализировал фразу
  | { type: "speak_start" } // первый TTS-чанк пошёл
  | { type: "speak_done" } // TTS завершился
  | { type: "barge_in" } // юзер заговорил во время speaking (§10)
  | { type: "followup_timeout" } // окно follow-up истекло (§10)
  | { type: "stop" } // внешний стоп («заткнись»): рубим TTS, в idle
  | { type: "mute" }; // честный mute: стоп захвата, в idle (§0.6)

export type VoiceAction =
  | { type: "open_stt" } // открыть/обеспечить STT-стрим, начать слать аудио
  | { type: "close_stt" } // финализировать STT (дождаться final)
  | { type: "call_agent"; text: string } // запустить brain на финальном тексте
  | { type: "cancel_tts" } // прервать синтез/воспроизведение (barge-in/stop)
  | { type: "arm_followup" } // запустить таймер follow-up окна
  | { type: "disarm_followup" } // снять таймер follow-up
  | { type: "set_client_state"; state: VoiceState }; // уведомить клиент (орб)

export interface VoiceContext {
  state: VoiceState;
  /** Активно ли follow-up окно (микрофон горячий без повторного wake word, §10). */
  followupActive: boolean;
}

export interface Transition {
  context: VoiceContext;
  actions: VoiceAction[];
}

export function initialContext(): VoiceContext {
  return { state: "idle", followupActive: false };
}

/** Без перехода (событие неактуально в текущем состоянии). */
function noop(ctx: VoiceContext): Transition {
  return { context: ctx, actions: [] };
}

function go(state: VoiceState, followupActive: boolean, actions: VoiceAction[]): Transition {
  return { context: { state, followupActive }, actions: [{ type: "set_client_state", state }, ...actions] };
}

/**
 * Главный редьюсер. Детерминированный, без таймеров/IO.
 * Таймер follow-up окна и сам STT/TTS живут в VoicePipeline; сюда приходят
 * уже готовые события (followup_timeout, transcript_final, speak_*).
 */
export function reduce(ctx: VoiceContext, ev: VoiceEvent): Transition {
  // stop/mute обрабатываются из любого состояния (приоритетно).
  if (ev.type === "stop" || ev.type === "mute") {
    const actions: VoiceAction[] = [];
    // cancel_tts и в thinking: отменяет ещё не озвученный, но УЖЕ ЗАПУЩЕННЫЙ ход агента
    // (инкремент gen в pipeline инвалидирует его поздний TTS), иначе Джарвис заговорит
    // поверх пользователя после стопа.
    if (ctx.state === "speaking" || ctx.state === "thinking") actions.push({ type: "cancel_tts" });
    if (ctx.state === "listening") actions.push({ type: "close_stt" });
    if (ctx.followupActive) actions.push({ type: "disarm_followup" });
    return go("idle", false, actions);
  }

  switch (ctx.state) {
    case "idle":
      // Активны только wake word. Всё прочее игнор (аудио ещё не стримится).
      if (ev.type === "wake") return go("listening", false, [{ type: "open_stt" }]);
      // Программная речь из покоя — фоновый итог (§20 async) или проактивность (§9): входим
      // в speaking, чтобы по завершении сработал штатный возврат speak_done → listening +
      // follow-up. Без этого произнесённый фоном ВОПРОС не переоткрывал микрофон → «перестал
      // слушать» (юзеру нечем ответить). Клиент при этом видит speaking → корректный эхо-гард.
      if (ev.type === "speak_start") return go("speaking", false, []);
      return noop(ctx);

    case "listening": {
      switch (ev.type) {
        case "speech_start":
          // Юзер заговорил — если это был follow-up, фиксируем реальный turn.
          if (ctx.followupActive) {
            return { context: { state: "listening", followupActive: false }, actions: [{ type: "disarm_followup" }] };
          }
          return noop(ctx);
        case "speech_end":
          // Конец речи → финализируем распознавание (эндпоинтинг — в TurnDetector).
          return { context: ctx, actions: [{ type: "close_stt" }] };
        case "transcript_final": {
          const text = ev.text.trim();
          if (text.length === 0) {
            // Пустой финал (тишина/шум): если был follow-up — досиживаем окно, иначе в idle.
            if (ctx.followupActive) return noop(ctx);
            return go("idle", false, [{ type: "close_stt" }]);
          }
          return go("thinking", false, [{ type: "call_agent", text }, { type: "close_stt" }]);
        }
        case "followup_timeout":
          if (ctx.followupActive) return go("idle", false, [{ type: "close_stt" }, { type: "disarm_followup" }]);
          return noop(ctx);
        case "wake":
          // Повторный wake во время listening — просто перезапускаем follow-up флаг.
          if (ctx.followupActive) return { context: { state: "listening", followupActive: false }, actions: [{ type: "disarm_followup" }] };
          return noop(ctx);
        case "speak_start":
          // Фоновый итог (§20) заговорил в окне follow-up: переходим в speaking, гася таймер
          // follow-up (после речи он перезапустится через speak_done → listening). Иначе
          // таймер истекал во время длинного ответа → уход в idle, и микрофон не возвращался.
          return go("speaking", false, ctx.followupActive ? [{ type: "disarm_followup" }] : []);
        default:
          return noop(ctx);
      }
    }

    case "thinking": {
      switch (ev.type) {
        case "speak_start":
          // brain отдал ответ, пошёл первый TTS-чанк.
          return go("speaking", false, []);
        case "barge_in":
        case "speech_start":
          // Юзер перебил на этапе обдумывания — ОТМЕНЯЕМ запущенный ход агента
          // (cancel_tts инкрементит gen → поздний ответ не озвучится) и слушаем заново (§10).
          return go("listening", false, [{ type: "cancel_tts" }, { type: "open_stt" }]);
        case "transcript_final":
          // Поздний финал от закрытого стрима — игнор (агент уже вызван).
          return noop(ctx);
        default:
          return noop(ctx);
      }
    }

    case "speaking": {
      switch (ev.type) {
        case "barge_in":
        case "speech_start":
          // Barge-in (§10): рубим TTS, мгновенно начинаем слушать.
          return go("listening", false, [{ type: "cancel_tts" }, { type: "open_stt" }]);
        case "speak_done":
          // Конец произнесения → follow-up окно: мик горячий без wake word (§10).
          return go("listening", true, [{ type: "open_stt" }, { type: "arm_followup" }]);
        default:
          return noop(ctx);
      }
    }
  }
}
