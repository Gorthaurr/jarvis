/**
 * Воля владельца по микрофону в main (§0.6 mic-kill-switch) + push-to-talk кнопкой (ревью 2026-09-24, B-F8).
 *
 * Renderer шлёт IPC activate в двух разных смыслах:
 *  1) стартовая синхронизация — «слух включён» (после подъёма захвата, при не выключенном микрофоне);
 *  2) владелец нажал кнопку микрофона и ВКЛЮЧИЛ его после «выключить» — жест «сейчас скажу».
 * Во втором случае при локальном wake нужно открыть гейт (push-to-talk), а в первом — НЕЛЬЗЯ: это ровно
 * W1-регрессия «гейт открыт после запуска» (ТВ в первые секунды шёл бы в облако и в команды).
 * Различаем по kill-switch: стартовая синхронизация приходит при выключенном kill-switch, включение
 * кнопкой — только после mute (renderer шлёт activate на включение сразу, ещё до подъёма захвата, поэтому
 * поздний activate из onUp приходит уже при снятом kill-switch и push-to-talk не повторяет).
 */
export interface MicTarget {
  activate(opts?: { hold?: boolean; ptt?: boolean }): void;
  mute(): void;
}

export class MicControl {
  private killSwitch = false;

  constructor(private readonly target: () => MicTarget | null) {}

  /** Владелец выключил микрофон — main помнит (enroll/прочие пути не откроют гейт «навсегда»). */
  get killSwitchOn(): boolean {
    return this.killSwitch;
  }

  /** IPC activate из renderer. true — это было включение кнопкой (push-to-talk). */
  activate(): boolean {
    const ptt = this.killSwitch;
    this.killSwitch = false;
    this.target()?.activate({ ptt });
    return ptt;
  }

  /** IPC mute из renderer. */
  mute(): void {
    this.killSwitch = true;
    this.target()?.mute();
  }
}
