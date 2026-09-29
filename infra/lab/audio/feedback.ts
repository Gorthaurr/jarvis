/**
 * Обратная связь сервер → клиентский слух, ровно как main/index.ts:334-347 (Transport.on → AudioCoordinator): client.state →
 * setServerState, wake.rescue.result → onWakeRescued, speak.chunk → фейковый плеер. LabClient подписки не даёт (только
 * events()), поэтому мост читает журнал с курсора — новые входящие события обрабатываются в порядке прихода.
 */
import type { ClientState } from "@jarvis/protocol";
import type { LabClient } from "../lib/contracts.js";
import type { FakePlayer } from "./fake-player.js";
import type { HearingProbe } from "./hearing-rig.js";
import { EventCursor } from "./event-cursor.js";
import type { SpeakChunkIn } from "./speech-store.js";

export interface FeedbackTarget {
  setServerState(s: ClientState): void;
  onWakeRescued(bare: boolean): void;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export class ServerFeedback {
  private readonly cursor: EventCursor;
  state: ClientState = "idle";
  /** Ход начался на сервере (был thinking/speaking) — после этого «конец» = вернулись в listening/idle. */
  engaged = false;
  lastEventAt = Date.now();
  readonly tasks = new Map<string, string>();
  speakChunks = 0;
  speakBytes = 0;
  /** Озвучка пришла без байтов (connectLabClient без keepAudio) — файлы не сохраняются. */
  audioStripped = false;

  constructor(
    client: LabClient,
    private readonly target: FeedbackTarget,
    private readonly player: FakePlayer,
    private readonly probe: HearingProbe,
  ) {
    this.cursor = new EventCursor(client);
  }

  /** Начало нового хода: счётчики хода сбрасываем, курсор оставляем (события между ходами тоже обработаны). */
  beginTurn(): void {
    this.engaged = this.state === "thinking" || this.state === "speaking";
    this.speakChunks = 0;
    this.speakBytes = 0;
    this.audioStripped = false;
    this.tasks.clear();
    this.lastEventAt = Date.now();
  }

  get tasksDone(): boolean {
    return [...this.tasks.values()].every((s) => TERMINAL.has(s));
  }

  /** Обработать новые события; вернуть, сколько их было. */
  drain(): number {
    let n = 0;
    for (const e of this.cursor.take()) {
      if (e.dir !== "in") continue;
      n += 1;
      this.lastEventAt = Date.now();
      const p = (e.payload ?? {}) as Record<string, unknown>;
      switch (e.type) {
        case "client.state":
          this.state = p.state as ClientState;
          if (this.state === "thinking" || this.state === "speaking") this.engaged = true;
          this.target.setServerState(this.state);
          break;
        case "wake.rescue.result":
          if (p.accepted === true) {
            this.probe.rescueVerdict = p.bare === true ? "bare" : "accepted";
            this.target.onWakeRescued(p.bare === true);
          }
          break;
        case "speak.chunk": {
          const audio = toBuffer(p.audio);
          this.speakChunks += 1;
          // LabClient без keepAudio режет audio из журнала (остаётся audioBytes): звук не сохранить — честно помечаем.
          if (audio.length === 0 && Number(p.audioBytes) > 0) this.audioStripped = true;
          this.speakBytes += audio.length || Number(p.audioBytes ?? 0);
          this.player.onChunk({ audio, seq: Number(p.seq ?? 0), last: p.last === true, ...(p.format ? { format: String(p.format) } : {}), ...(p.sampleRate ? { sampleRate: Number(p.sampleRate) } : {}), ...(typeof p.gen === "number" ? { gen: p.gen } : {}) } satisfies SpeakChunkIn);
          break;
        }
        case "task.status":
          this.tasks.set(String(p.taskId), String(p.state));
          if (!TERMINAL.has(String(p.state))) this.engaged = true;
          break;
        default:
      }
    }
    return n;
  }
}

/** speak.chunk.audio: base64-строка (сервер) либо уже байты (если клиент лаборатории раскодировал). */
export function toBuffer(a: unknown): Buffer {
  if (typeof a === "string") return Buffer.from(a, "base64");
  if (Buffer.isBuffer(a)) return a;
  if (a instanceof Uint8Array) return Buffer.from(a);
  if (a instanceof ArrayBuffer) return Buffer.from(a);
  return Buffer.alloc(0);
}
