/**
 * Прокси-верификатор диктора через speaker-САЙДКАР (§3). Реализует ISpeakerVerifier, но НЕ грузит
 * sherpa-onnx в главном процессе (конфликт с onnxruntime-node эмбеддера e5 на Windows) — форвардит
 * enroll/identify в дочерний Node-процесс (sidecar-host), где sherpa изолирован. Любой сбой канала
 * → null/0 (fail-open: гейт пропускает, владельца не запирает); запуск не удался → MockSpeakerVerifier.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type EnrollSession,
  type ISpeakerVerifier,
  MockSpeakerVerifier,
  type SpeakerMatch,
  type VoiceProfile,
} from "./verifier.js";
import {
  type HostRequest,
  type HostResponse,
  type ProfileWire,
  b64ToBytes,
  bytesToB64,
  createLineParser,
  pcmToB64,
} from "./sidecar-protocol.js";

const log: Logger = createLogger("speaker:sidecar");

type Hello = Extract<HostResponse, { t: "hello" }>;

/** Зависимости прокси (инъекция канала — для прямого юнит-теста без spawn). */
export interface SidecarProxyDeps {
  hello: Hello;
  /** Отправить запрос в сайдкар (главный → дочерний). */
  send: (req: HostRequest) => void;
  /** Жив ли канал; false → запросы безопасно деградируют (identify→null, feed→0). */
  alive: () => boolean;
  /** L3: убить дочерний процесс сайдкара (для dispose на gateway.close()). Опционально (юнит-тест без spawn). */
  kill?: () => void;
  /** Таймаут ответа сайдкара, мс (деф 8000). */
  timeoutMs?: number;
}

export class SidecarSpeakerVerifier implements ISpeakerVerifier {
  readonly ready = true;
  readonly enrollSeconds: number;
  readonly threshold: number;
  readonly acceptThreshold: number;
  readonly rejectThreshold: number;
  readonly dim: number;
  readonly modelId: string;

  private nextId = 1;
  private nextSess = 1;
  private readonly pending = new Map<number, { resolve: (r: HostResponse | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: SidecarProxyDeps) {
    this.dim = deps.hello.dim;
    this.modelId = deps.hello.modelId;
    this.threshold = deps.hello.threshold;
    this.acceptThreshold = deps.hello.acceptThreshold;
    this.rejectThreshold = deps.hello.rejectThreshold;
    this.enrollSeconds = deps.hello.enrollSeconds;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
  }

  /** Входящий ответ сайдкара — резолвит ожидающего по id (hello здесь не приходит). */
  receive(res: HostResponse): void {
    if (res.t === "hello") return;
    const p = this.pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    p.resolve(res);
  }

  /** Канал умер (exit/error) — все ожидания резолвим в null (fail-open). */
  fail(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  /** L3: остановить сайдкар — убить дочерний процесс и резолвить ожидания (иначе sherpa-child остаётся
   *  зомби с моделью в памяти при taskkill /F на порту сервера). Вызывается в gateway.close(). Идемпотентно. */
  dispose(): void {
    try {
      this.deps.kill?.();
    } catch {
      /* уже мёртв */
    }
    this.fail();
  }

  private request(make: (id: number) => HostRequest): Promise<HostResponse | null> {
    if (!this.deps.alive()) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<HostResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, timer });
      try {
        this.deps.send(make(id));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async identify(pcm: Int16Array, profiles: readonly VoiceProfile[]): Promise<SpeakerMatch | null> {
    if (profiles.length === 0) return null;
    const wire: ProfileWire[] = profiles.map((p) => ({
      name: p.name,
      data: bytesToB64(p.data),
      createdAt: p.createdAt,
      ...(p.dim !== undefined ? { dim: p.dim } : {}),
      ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
    }));
    const res = await this.request((id) => ({ t: "identify", id, pcm: pcmToB64(pcm), profiles: wire }));
    return res?.t === "identify.res" ? res.match : null;
  }

  enroll(): EnrollSession {
    const sess = this.nextSess++;
    if (this.deps.alive()) {
      try {
        this.deps.send({ t: "enroll.start", sess });
      } catch {
        /* мёртвый канал — feed/finish вернут 0/null */
      }
    }
    const self = this;
    return {
      async feed(pcm: Int16Array) {
        const res = await self.request((id) => ({ t: "enroll.feed", id, sess, pcm: pcmToB64(pcm) }));
        return res?.t === "enroll.feed.res" ? res.pct : 0;
      },
      async finish() {
        const res = await self.request((id) => ({ t: "enroll.finish", id, sess }));
        return res?.t === "enroll.finish.res" && res.data ? b64ToBytes(res.data) : null;
      },
      cancel() {
        if (self.deps.alive()) {
          try {
            self.deps.send({ t: "enroll.cancel", sess });
          } catch {
            /* всё равно завершаемся */
          }
        }
      },
    };
  }
}

/**
 * Поднять speaker-сайдкар: spawn дочернего Node (tsx) с sidecar-host, дождаться hello, вернуть прокси.
 * Нет hello вовремя / ready:false / сбой spawn → MockSpeakerVerifier (гейт диктора выключен — безопасно,
 * как было). Никогда не роняет boot. helloTimeoutMs щедрый: загрузка sherpa-модели занимает секунды.
 */
export async function createSpeakerVerifierSidecar(opts?: { helloTimeoutMs?: number }): Promise<ISpeakerVerifier> {
  const hostPath = fileURLToPath(new URL("./sidecar-host.ts", import.meta.url));
  let child: ChildProcess;
  try {
    // Дочерний node под tsx-лоадером (главный сервер тоже под tsx). stderr наследуем (логи/нативный
    // вывод sherpa не мешают протоколу — он только в stdout, парсер игнорит не-JSON строки).
    child = spawn(process.execPath, ["--import", "tsx", hostPath], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  } catch (e) {
    log.warn("speaker-сайдкар не запустился — верификация диктора выключена", { error: e instanceof Error ? e.message : String(e) });
    return new MockSpeakerVerifier();
  }

  let dead = false;
  const alive = (): boolean => !dead && !child.killed;

  return await new Promise<ISpeakerVerifier>((resolve) => {
    let settled = false;
    let proxy: SidecarSpeakerVerifier | null = null;
    const finishWith = (v: ISpeakerVerifier): void => {
      if (settled) return;
      settled = true;
      clearTimeout(helloTimer);
      resolve(v);
    };
    const helloTimer = setTimeout(() => {
      log.warn("speaker-сайдкар не прислал hello вовремя — гейт диктора выключен");
      try {
        child.kill();
      } catch {
        /* уже мёртв */
      }
      finishWith(new MockSpeakerVerifier());
    }, opts?.helloTimeoutMs ?? 20_000);
    if (typeof helloTimer.unref === "function") helloTimer.unref();

    const onFrame = (frame: HostResponse): void => {
      if (frame.t === "hello") {
        if (!frame.ready) {
          log.warn("speaker-сайдкар: движок не готов (нет модели/sherpa) — гейт выключен");
          try {
            child.kill();
          } catch {
            /* noop */
          }
          finishWith(new MockSpeakerVerifier());
          return;
        }
        proxy = new SidecarSpeakerVerifier({
          hello: frame,
          alive,
          send: (req) => child.stdin?.write(`${JSON.stringify(req)}\n`),
          kill: () => {
            dead = true;
            try {
              child.kill();
            } catch {
              /* уже мёртв */
            }
          },
        });
        log.info("движок отпечатка готов (sherpa в сайдкаре, изолирован от e5)", { dim: frame.dim, modelId: frame.modelId });
        finishWith(proxy);
      } else {
        proxy?.receive(frame);
      }
    };

    child.stdout?.on("data", createLineParser<HostResponse>(onFrame));
    child.on("error", (e) => {
      log.warn("speaker-сайдкар: ошибка процесса", { error: e.message });
      dead = true;
      proxy?.fail();
      finishWith(new MockSpeakerVerifier());
    });
    child.on("exit", (code) => {
      dead = true;
      proxy?.fail();
      if (!settled) {
        log.warn("speaker-сайдкар завершился до hello — гейт выключен", { code });
        finishWith(new MockSpeakerVerifier());
      } else {
        log.warn("speaker-сайдкар завершился — верификация деградирует (fail-open)", { code });
      }
    });
  });
}
