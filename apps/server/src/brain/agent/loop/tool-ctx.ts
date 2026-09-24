// W3 «Петля»: ToolContext для dispatchTool — зависимости хендлеров инструментов.
import { confirmWindowMs } from "./util.js";
import type { AgentDeps, LoopOpts } from "../types.js";
import type { ToolContext } from "../../tools/dispatch.js";
import { newId } from "@jarvis/protocol";
import type { Session } from "../../../gateway/session.js";

export function makeToolCtx(deps: AgentDeps, session: Session, opts: LoopOpts | undefined): ToolContext {
  const toolCtx = {
    session,
    web: deps.web,
    episodic: deps.episodic,
    userId: deps.userId,
    // ВОЛНА H (шаг 3): деп хука противоречий для `memory_write` — самого частого пути записи.
    // Дешёвый тир и учёт трат: фоновая проверка не обходит месячный потолок.
    contradiction: { llm: deps.llm, model: deps.models.sonnet, spend: deps.spend },
    // Подтверждение необратимого (§14): kind задаёт вид модалки (send|order|irreversible),
    // чтобы удаление/выключение/код не показывались как обычная «отправка».
    confirm: (summary: string, kind: "send" | "order" | "irreversible" = "send") =>
      session
        .requestConfirm({ requestId: newId(), summary, kind, expiresAt: Date.now() + confirmWindowMs() })
        .then((r) => ({
          // Ф0 пульта: исход РАЗЛИЧИМ. Клиент шлёт только осознанное решение владельца → нет outcome =
          // approved/denied по флагу; «не смог спросить»/«не дождался» проставляет Session (fail-fast,
          // teardown, истечение окна). `approved` оставлено производным — старые ветки не ломаются.
          outcome: r.outcome ?? (r.approved ? ("approved" as const) : ("denied" as const)),
          approved: r.approved,
          ...(r.revision !== undefined ? { revision: r.revision } : {}),
        })),
    productMode: deps.productMode, // self_* — инструменты владельца машины, не арендатора
    devSession: deps.devSession, // T-F1: смоук агента не пишет в память владельца
    dynamicTools: deps.dynamicTools,
    skills: deps.skills,
    market: deps.market, // §трейдинг: рыночные данные + анализ (только чтение)
    appChannels: deps.appChannels, // реестр программных каналов: «у приложения есть API — не кликай»
    appUsage: deps.appUsage, // W4.2: минуты фокуса по процессу — покрытие частых программ каналами
    knowledge: deps.knowledge, // §экспертность: база знаний (свериться перед экспертной задачей)
    telegramSend: deps.telegramSend, // §6: невидимая отправка в TG через расширение
    telegramSendVoice: deps.telegramSendVoice, // §: голосовое в TG голосом филиппа
    synthVoice: deps.synthVoice, // §: синтез TTS для голосовых
    reminders: deps.reminders, // §9: durable-напоминания + проактивная озвучка
    watch: deps.watch, // §долгие-задачи: durable наблюдение/мониторинг + проактивная озвучка
    obligations: deps.obligations, // §проактив-всё: счета/обязательства (ambient напоминает по датам)
    activities: deps.activities, // фоновые активности: чип виден, пока идёт работа (автолистание Shorts)
    origin: "user" as const, // §бесшумный-ввод: agent-петля исполняет реплику юзера → физ.ввод не гейтить присутствием
    // §режим выделения: машинный реэнтри (watch-action) НЕ имеет права открывать оверлей поверх экрана —
    // просить владельца обвести можно только в ответ на его реплику.
    machineTurn: opts?.machine === true,

    resolutionMemory: deps.resolutionMemory, // §: опытная память резолва (скорость)
    sessionId: session.sessionId,
    systemContext: () => deps.userContext?.systemContext ?? "", // §14 гейт GUI-коммитов: процесс на переднем плане
    // Контроль-9 (browser-open-ext-bypasses-veil): фаза рисования нужна хендлеру ДО выбора канала — путь через
    // расширение (штатный) клиентского гейта не проходит вовсе.
    veilDrawing: () => deps.selection?.drawing === true,
    ext: deps.ext, // §: браузер пользователя через расширение (browser_open/read/act в его вкладках)
    toolActivation: deps.toolActivation, // §15: набор подгруженных холодных инструментов (tool_load)
    mcp: deps.mcp, // § MCP-host: исполнение mcp__-инструментов через callTool
  };
  return toolCtx;
}
