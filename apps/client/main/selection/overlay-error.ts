/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — ошибка «поверх экрана вуаль» и гарды ТОЧКИ ИНЖЕКЦИИ (контроль-6, SR-C6-1/C5R-2).
 * Раньше класс жил в actuators/input.ts, и гард стоял только у input.*: реплей навыка звал apps.focusApp /
 * windows.focusWindow напрямую (мимо раннего гейта dispatch) и отбирал клавиатуру у окна рисования.
 * Здесь нет Electron и нет сайдкара — гард достижим в тестах без него.
 */
import { selectionStore } from "./store.js";

export class DrawingOverlayError extends Error {
  /** Действие УЖЕ УШЛО в GUI (RPC вернулся), а вуаль открылась в его окне — исход не подтверждён, а не «не выполнено». */
  readonly injected: boolean;
  constructor(reason: string, injected = false) {
    super(reason);
    this.name = "DrawingOverlayError";
    this.injected = injected;
  }
}

/** ДО инжекции: открыт оверлей → физический ввод/смена фокуса попали бы в него. */
export function assertNoDrawingOverlay(): void {
  const reason = selectionStore.physicalInputBlockReason();
  if (reason) throw new DrawingOverlayError(reason);
}

/**
 * ПОСЛЕ инжекции долгого действия (печать посимвольно — десятки секунд, drag с интерполяцией): вуаль открылась
 * в окне [t0, сейчас] → остаток нажатий ушёл в сфокусированное окно рисования, а RPC вернул ok. «Готово» тут —
 * ложный успех: исход НЕ ПОДТВЕРЖДЁН (injected=true → сервер: overlayActionInjected, журнал: «сверь перед повтором»).
 */
export function assertNoOverlayDuring(t0: number, what: string): void {
  if (!(selectionStore.drawing || selectionStore.drawingEndedAfter(t0))) return;
  const state = selectionStore.physicalInputBlockReason() ?? "Поверх экрана была вуаль режима выделения (уже закрылась).";
  throw new DrawingOverlayError(
    `${what} УЖЕ УШЛО в GUI, когда открылся оверлей режима выделения — часть могла попасть в него, а не в цель; ` +
      `ИСХОД НЕ ПОДТВЕРЖДЁН: сверь состояние (поле/экран), не повторяй вслепую. ${state}`,
    true,
  );
}
