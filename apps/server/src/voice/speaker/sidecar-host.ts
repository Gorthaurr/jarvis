/**
 * speaker-САЙДКАР (дочерний процесс, §3): здесь — и ТОЛЬКО здесь — грузится sherpa-onnx (нативный
 * onnxruntime). Изолирован от главного процесса, где живёт onnxruntime-node эмбеддера e5 (вместе
 * в одном процессе на Windows они конфликтуют). Принимает запросы по stdin (newline JSON),
 * исполняет реальным верификатором, отвечает по stdout. Запускается из verifier-sidecar.ts.
 *
 * ВАЖНО: в stdout идёт ТОЛЬКО протокол (по строке JSON на ответ). Логи/нативный вывод — в stderr
 * (наследуется родителем); родительский парсер всё равно игнорит не-JSON строки (defense-in-depth).
 */
import { createSpeakerVerifier } from "./sherpa-verifier.js";
import type { EnrollSession, VoiceProfile } from "./verifier.js";
import {
  type HostRequest,
  type HostResponse,
  b64ToBytes,
  b64ToPcm,
  bytesToB64,
  createLineParser,
} from "./sidecar-protocol.js";

async function main(): Promise<void> {
  const write = (m: HostResponse): void => void process.stdout.write(`${JSON.stringify(m)}\n`);

  const verifier = await createSpeakerVerifier(); // sherpa грузится В ЭТОМ процессе (или Mock, если нет модели)
  write({
    t: "hello",
    ready: verifier.ready,
    dim: verifier.dim,
    modelId: verifier.modelId,
    threshold: verifier.threshold,
    acceptThreshold: verifier.acceptThreshold,
    rejectThreshold: verifier.rejectThreshold,
    enrollSeconds: verifier.enrollSeconds,
  });
  // Движок не готов (Mock) → родитель уже получил ready:false и завершит нас; не обслуживаем запросы.
  if (!verifier.ready) return;

  const sessions = new Map<number, EnrollSession>();

  const handle = async (req: HostRequest): Promise<void> => {
    try {
      switch (req.t) {
        case "identify": {
          const profiles: VoiceProfile[] = req.profiles.map((p) => ({
            name: p.name,
            data: b64ToBytes(p.data),
            createdAt: p.createdAt,
            ...(p.dim !== undefined ? { dim: p.dim } : {}),
            ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
          }));
          const match = await verifier.identify(b64ToPcm(req.pcm), profiles);
          write({ t: "identify.res", id: req.id, match });
          break;
        }
        case "enroll.start":
          sessions.set(req.sess, verifier.enroll());
          break;
        case "enroll.feed": {
          const pct = (await sessions.get(req.sess)?.feed(b64ToPcm(req.pcm))) ?? 0;
          write({ t: "enroll.feed.res", id: req.id, pct });
          break;
        }
        case "enroll.finish": {
          const data = (await sessions.get(req.sess)?.finish()) ?? null;
          sessions.delete(req.sess);
          write({ t: "enroll.finish.res", id: req.id, data: data ? bytesToB64(data) : null });
          break;
        }
        case "enroll.cancel":
          sessions.get(req.sess)?.cancel();
          sessions.delete(req.sess);
          break;
      }
    } catch (e) {
      // Никогда не оставляем родителя висеть в ожидании — отвечаем заглушкой (fail-open).
      process.stderr.write(`speaker-host: ошибка обработки ${req.t}: ${e instanceof Error ? e.message : String(e)}\n`);
      if (req.t === "identify") write({ t: "identify.res", id: req.id, match: null });
      else if (req.t === "enroll.feed") write({ t: "enroll.feed.res", id: req.id, pct: 0 });
      else if (req.t === "enroll.finish") write({ t: "enroll.finish.res", id: req.id, data: null });
    }
  };

  const parse = createLineParser<HostRequest>((req) => void handle(req));
  process.stdin.on("data", parse);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

void main().catch((e) => {
  process.stderr.write(`speaker-host: фатальная ошибка: ${e instanceof Error ? e.message : String(e)}\n`);
  // Родитель увидит exit без hello → MockSpeakerVerifier (гейт выключен).
  process.exit(1);
});
