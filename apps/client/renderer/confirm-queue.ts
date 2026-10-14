import type { ConfirmRequest } from "@jarvis/protocol";

/** FIFO подтверждений; истечение не является отказом владельца — его фиксирует сервер. */
export class ConfirmQueue {
  private requests: ConfirmRequest[] = [];
  private shown: ConfirmRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly show: (request: ConfirmRequest | null) => void) {}

  enqueue(request: ConfirmRequest): void {
    if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) return;
    if (this.requests.some((r) => r.requestId === request.requestId)) return;
    this.requests.push(request);
    this.refresh();
  }

  /** Клик относится только к показанному вопросу, даже если его таймер задержался. */
  take(requestId: string): ConfirmRequest | undefined {
    const current = this.requests[0];
    const valid = current?.requestId === requestId && current.expiresAt > Date.now();
    if (valid) this.requests.shift();
    this.refresh();
    return valid ? current : undefined;
  }

  dispose(): void {
    this.requests = [];
    this.refresh();
  }

  private refresh(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    this.requests = this.requests.filter((r) => r.expiresAt > now);
    const next = this.requests[0] ?? null;
    if (next !== this.shown) {
      this.shown = next;
      this.show(next);
    }
    if (this.requests.length) {
      const deadline = Math.min(...this.requests.map((r) => r.expiresAt));
      this.timer = setTimeout(() => this.refresh(), Math.min(2_147_483_647, Math.max(0, deadline - now)));
    }
  }
}
