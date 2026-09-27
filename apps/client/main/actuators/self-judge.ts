/**
 * W2 (пакет 0): судья «self» рубежа инжекции — ЗАГЛУШКА (null: пропускает). Реализует П1.
 * СВОЁ окно/процесс Джарвиса — любая мутация туда неодобряема (модалка «Подтвердить» — обычный DOM-клик):
 * handle с pid = process.pid в зеркале; windowAt(точка).pid (фолбэк — видимый свой BrowserWindow); клавиатура при ownFocused().
 */
import type { Judge } from "./injection-guard.js";

export const selfJudge: Judge = async () => null;
