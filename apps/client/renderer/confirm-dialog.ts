/**
 * Модалка подтверждения send/order/irreversible (§14) — вынесено из god-file renderer.ts (§ревью).
 * Revise-петля (approved:false + revision → сервер перегенерирует), клик по фону = отклонить (безопасный
 * дефолт). jarvis — DI-аргумент init. Экспортирует isConfirmOpen/denyConfirm для глобального ESC-хендлера
 * (чтобы тот не лез в чужой DOM). Тип ConfirmRequest — type-only из @jarvis/protocol (цикла нет).
 */
import type { ConfirmRequest } from "@jarvis/protocol";
import type { JarvisBridge } from "../main/ipc-contract.js";
import { $ } from "./dom.js";
import { rememberFocus, restoreFocus } from "./focus-trap.js";

const confirmOverlay = $("confirmOverlay");
const confirmKind = $("confirmKind");
const confirmSummary = $("confirmSummary");
const revisionInput = $<HTMLInputElement>("revisionInput");
const approveBtn = $<HTMLButtonElement>("approveBtn");
const reviseBtn = $<HTMLButtonElement>("reviseBtn");
const denyBtn = $<HTMLButtonElement>("denyBtn");

let activeConfirm: ConfirmRequest | null = null;

// Локализация вида подтверждения (в макете бейдж «Отправка», а не сырой enum send/order/...).
const CONFIRM_KIND_RU: Record<ConfirmRequest["kind"], string> = {
  send: "Отправка",
  order: "Заказ",
  irreversible: "Действие",
};

function openConfirm(req: ConfirmRequest): void {
  activeConfirm = req;
  confirmKind.textContent = CONFIRM_KIND_RU[req.kind] ?? req.kind;
  confirmSummary.textContent = req.summary;
  revisionInput.value = "";
  rememberFocus();
  confirmOverlay.classList.remove("overlay--hidden");
  revisionInput.focus(); // фокус внутрь диалога (нейтральное поле, не деструктивная кнопка)
}

function closeConfirm(): void {
  activeConfirm = null;
  confirmOverlay.classList.add("overlay--hidden");
  restoreFocus();
}

/** Открыта ли модалка подтверждения — для глобального ESC-хендлера (без доступа к её DOM). */
export function isConfirmOpen(): boolean {
  return !confirmOverlay.classList.contains("overlay--hidden");
}

/** Отклонить подтверждение (ESC/программно) — эквивалент клика «Отклонить» (безопасный дефолт). */
export function denyConfirm(): void {
  denyBtn.click();
}

/** Инициализация модалки (§14): кнопки approve/revise/deny + клик по фону + подписка onConfirmRequest. */
export function initConfirmDialog(jarvis: JarvisBridge): void {
  approveBtn.addEventListener("click", () => {
    if (!activeConfirm) return;
    jarvis.sendConfirmResult({ requestId: activeConfirm.requestId, approved: true });
    closeConfirm();
  });

  reviseBtn.addEventListener("click", () => {
    // §14 revise-петля: approved:false + revision -> сервер перегенерирует и пришлёт новый confirm.
    if (!activeConfirm) return;
    const revision = revisionInput.value.trim();
    jarvis.sendConfirmResult({
      requestId: activeConfirm.requestId,
      approved: false,
      revision: revision || undefined,
    });
    closeConfirm();
  });

  denyBtn.addEventListener("click", () => {
    if (!activeConfirm) return;
    jarvis.sendConfirmResult({ requestId: activeConfirm.requestId, approved: false });
    closeConfirm();
  });

  // Клик по затемнению вне окна = отклонить (безопасный дефолт: действие НЕ выполняется, сервер
  // получает ответ, а не зависает в ожидании). ESC обрабатывается глобально в renderer.
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) denyBtn.click();
  });

  jarvis.onConfirmRequest((r: ConfirmRequest) => openConfirm(r));
}
