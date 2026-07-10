/**
 * Запись голосового отпечатка (§3 enrollment) — вынесено из god-file router-ws.ts (§ревью).
 * Старт записи, кормление аудио-кадрами с прогрессом, финализация в SpeakerStore (раздел юзера,
 * тег модели отпечатка), отдача клиенту списка enrolled-голосов. `SessionContext` импортируется
 * type-only → рантайм-цикла с router-ws нет (router-ws тянет эти функции как значения).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { SessionContext } from "./router-ws.js";

const log: Logger = createLogger("voice-enroll");

/** §3: начать запись голосового отпечатка (движок должен быть готов). */
export function startVoiceEnroll(ctx: SessionContext, name: string): void {
  const clean = (name ?? "").trim();
  if (!ctx.speakerVerifier?.ready || !ctx.speakerStore || !clean) {
    ctx.session.send("voice.enroll.done", { name: clean, ok: false });
    return;
  }
  ctx.enroll = { name: clean, session: ctx.speakerVerifier.enroll(), sentPct: 0 };
  log.info("запись голоса начата", { name: clean });
}

/** §3: кормить enrollment аудио-кадром; на 100% — финализировать и сохранить отпечаток. */
export async function feedEnroll(ctx: SessionContext, pcm: ArrayBuffer): Promise<void> {
  const enroll = ctx.enroll;
  if (!enroll || !ctx.speakerStore) return;
  const percent = await enroll.session.feed(new Int16Array(pcm));
  // Прогресс — не на каждый кадр (их ~десятки/сек): только заметными шагами.
  if (percent - enroll.sentPct >= 0.04 || percent >= 1) {
    enroll.sentPct = percent;
    ctx.session.send("voice.enroll.progress", { percent });
  }
  if (percent >= 1) {
    ctx.enroll = undefined;
    const data = await enroll.session.finish();
    let ok = false;
    if (data) {
      // §3 Фаза 0: тегируем профиль моделью отпечатка (dim+modelId) — чтобы при смене модели
      // его можно было отбраковать, а не сравнивать мусорным косинусом.
      const v = ctx.speakerVerifier;
      await ctx.speakerStore.add(
        ctx.session.userId, // §мультитенант: голос пишется в раздел ЭТОГО юзера
        enroll.name,
        data,
        v ? { dim: v.dim, modelId: v.modelId } : undefined,
      );
      ok = true;
    }
    ctx.session.send("voice.enroll.done", { name: enroll.name, ok });
    sendVoiceList(ctx);
    log.info("запись голоса завершена", { name: enroll.name, ok });
  }
}

/** §3: отправить клиенту текущий список enrolled-голосов. */
export function sendVoiceList(ctx: SessionContext): void {
  ctx.session.send("voice.voices", { names: (ctx.speakerStore?.list(ctx.session.userId) ?? []).map((p) => p.name) });
}
