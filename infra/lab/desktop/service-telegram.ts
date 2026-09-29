/**
 * telegram.send / telegram.read FakeDesktop: веб-Telegram в невидимом браузере Джарвиса. Чаты — из опций или seed-файла
 * `~/.lab/telegram.json` ({loggedIn, chats:[{title, peerId, messages:[{dir,text}]}]}); исходящее пишется в чат и в
 * журнал эффектов, наружу не уходит. Резолв получателя — настоящий pickRecipient (тёзки → «спроси владельца»), тексты
 * ошибок — как у jarvis-browser.ts (`[tg-resolve]` …). Третий исход закона 1 (ушло, но не подтвердилось) — опцией.
 */
import type { ActionCommand } from "@jarvis/protocol";
import { type Candidate, foldName, pickRecipient } from "@jarvis/shared";
import type { DesktopCore, KindHandlers } from "./core.js";
import type { ServiceOptions, TgChatSeed } from "./service-options.js";
import { runState, str } from "./service-state.js";

interface Chat {
  title: string;
  peerId: string;
  messages: Array<{ dir: "in" | "out"; text: string }>;
}
interface Tg {
  loggedIn: boolean;
  chats: Chat[];
}
type Hint = { preferredTitle?: string; hintPeerId?: string };

const WEBK = "https://web.telegram.org/k/";

function seedChats(list: TgChatSeed[]): Chat[] {
  return list.map((c, i) => ({ title: c.title, peerId: c.peerId ?? String(1000 + i), messages: [...(c.messages ?? [])] }));
}

export function telegramHandlers(core: DesktopCore, opts: () => ServiceOptions): KindHandlers {
  const state = (): Tg =>
    runState<Tg>(core, "telegram", () => {
      const o = opts();
      const raw = core.fs.files.get(`${core.fs.home}/.lab/telegram.json`);
      let file: { loggedIn?: boolean; chats?: TgChatSeed[] } = {};
      try {
        if (raw) file = JSON.parse(raw.toString("utf8")) as typeof file;
      } catch {
        /* битый seed — как будто файла нет */
      }
      return { loggedIn: file.loggedIn ?? o.telegramLoggedIn, chats: seedChats(file.chats ?? o.telegramChats) };
    });

  /** Общая часть send/read: браузер, вход, резолв чата. Бросает Error с текстом клиента. */
  function openChat(to: string, hint: Hint): Chat {
    if (!core.installedApps.has("chrome")) throw new Error("Chrome не найден — браузер Джарвиса недоступен");
    const tg = state();
    if (!tg.loggedIn) {
      core.effect("jbrowser.login_window", { url: WEBK });
      throw new Error("Telegram не залогинен — открыл окно входа. Войдите (номер→код→облачный пароль) и повторите.");
    }
    if (/избранн|saved/iu.test(to)) {
      let saved = tg.chats.find((c) => c.title === "Saved Messages");
      if (!saved) tg.chats.push((saved = { title: "Saved Messages", peerId: "1", messages: [] }));
      return saved;
    }
    if (hint.preferredTitle) {
      const hit = tg.chats.find((c) => (hint.hintPeerId ? c.peerId === hint.hintPeerId : foldName(c.title) === foldName(hint.preferredTitle!)));
      if (hit) return hit;
    }
    const cands: Candidate[] = tg.chats.map((c) => ({ title: c.title, peerId: c.peerId, preview: c.messages.at(-1)?.text.slice(0, 80) ?? "", mine: true }));
    const pick = pickRecipient(to, cands);
    if (pick.action === "none") {
      const seen = cands.map((c) => c.title).filter(Boolean);
      throw new Error(`[tg-resolve] Не нашёл в Telegram контакт «${to}».${seen.length ? ` Видно чаты: ${seen.join(" | ")}.` : ""} Уточни имя получателя.`);
    }
    if (pick.action === "ask") {
      const list = pick.ranked.map((c) => `«${c.title}» (id=${c.peerId ?? "?"})`).join(" | ");
      if (pick.reason === "namesakes") {
        throw new Error(`[tg-resolve] «${to}» — ТЁЗКИ, несколько контактов с этим именем: ${list}. НЕ выбирай сам(а) — СПРОСИ владельца, кому именно, и повтори telegram_send с peer нужного кандидата (id из списка).`);
      }
      throw new Error(`[tg-resolve] «${to}» — неоднозначно, наугад не шлю. Кандидаты: ${list}. Выбери того, кто по смыслу = «${to}» и повтори с peer нужного кандидата (id из списка) или точным именем чата.`);
    }
    const chat = tg.chats.find((c) => (pick.peerId ? c.peerId === pick.peerId : c.title === pick.title));
    if (!chat) throw new Error(`telegram: не открыл чат «${pick.title ?? to}» (этап open-by-title)`);
    return chat;
  }

  return {
    "telegram.send": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "telegram.send" }>;
      try {
        if (!str(c.to).trim() || !str(c.text).trim()) throw new Error("telegram: нужны to и text");
        const chat = openChat(c.to, c);
        chat.messages.push({ dir: "out", text: c.text });
        const confirmed = !opts().telegramUnconfirmed;
        core.effect("telegram.send", { to: c.to, chatTitle: chat.title, peerId: chat.peerId, text: c.text, confirmed });
        if (!confirmed) throw new Error("telegram: не увидел своё сообщение в чате за 8с — доставка НЕ подтверждена (могло и уйти)");
        return core.ok(meta.commandId, { delivered: true, chatTitle: chat.title, peerId: chat.peerId });
      } catch (e) {
        return core.fail(meta.commandId, "runtime", e instanceof Error ? e.message : String(e));
      }
    },

    "telegram.read": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "telegram.read" }>;
      try {
        if (!str(c.to).trim()) throw new Error("telegram: нужен to (чат)");
        const chat = openChat(c.to, c);
        const n = Number(c.count) || 12;
        core.effect("telegram.read", { to: c.to, chatTitle: chat.title, count: n });
        return core.ok(meta.commandId, { chatTitle: chat.title, messages: chat.messages.slice(-n).map((m) => ({ ...m })) });
      } catch (e) {
        return core.fail(meta.commandId, "runtime", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
