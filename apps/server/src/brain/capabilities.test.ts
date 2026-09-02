import { describe, expect, it } from "vitest";
import { type CapabilityInput, renderCapabilityPassport } from "./capabilities.js";

const base: CapabilityInput = {
  extensionConnected: true,
  mcpServers: [],
  braveKey: false,
  tinkoffToken: true,
  obsConfigured: true,
  autonomyFrozenReason: null,
};

// Волна E: паспорт возможностей — честность ДО провала (не обещать мёртвый канал).
describe("renderCapabilityPassport", () => {
  it("расширение не подключено → модель предупреждена и знает, что предложить владельцу", () => {
    const t = renderCapabilityPassport({ ...base, extensionConnected: false });
    expect(t).toContain("НЕ ПОДКЛЮЧЕНО");
    expect(t).toContain("chrome://extensions");
  });

  it("MCP: подключённые и упавшие показываются РАЗДЕЛЬНО (упавший ≠ доступный)", () => {
    const t = renderCapabilityPassport({
      ...base,
      mcpServers: [
        { server: "think", state: "connected", tools: 1 },
        { server: "github", state: "error", tools: 0 },
      ],
    });
    expect(t).toContain("think");
    expect(t).toMatch(/НЕ поднялись: .*github/);
  });

  it("killswitch виден: модель может честно объяснить «почему молчу» и назвать команду возврата", () => {
    const t = renderCapabilityPassport({ ...base, autonomyFrozenReason: "команда владельца" });
    expect(t).toContain("ОСТАНОВЛЕНА");
    expect(t).toContain("включи автономию");
  });

  it("отсутствие ключей называется честно, без ложного «недоступен» для поиска (DDG работает keyless)", () => {
    const t = renderCapabilityPassport({ ...base, braveKey: false, tinkoffToken: false, obsConfigured: false });
    expect(t).toContain("DuckDuckGo");
    expect(t).toContain("поиск работает");
    expect(t).toContain("tinkoff_portfolio");
    expect(t).toContain("obs_request");
  });

  it("кап размера: пер-списочный («и ещё N»), паспорт не разъедает окно даже с абсурдным списком MCP", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ server: `srv-${i}-${"x".repeat(30)}`, state: "connected", tools: i }));
    const t = renderCapabilityPassport({ ...base, mcpServers: many });
    expect(t.length).toBeLessThanOrEqual(1101);
    expect(t).toContain("и ещё 194"); // список капается ЧЕСТНО, с указанием отброшенного
  });

  it("контроль-ревью: killswitch-строка ПЕРВАЯ — длинный MCP-список её не срезает", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ server: `srv-${i}-${"x".repeat(30)}`, state: "error", tools: 0 }));
    const t = renderCapabilityPassport({ ...base, mcpServers: many, autonomyFrozenReason: "команда владельца" });
    expect(t).toContain("ОСТАНОВЛЕНА");
    expect(t).toContain("включи автономию");
  });

  it("контроль-ревью: без расширения browser_open честно назван ДОСТУПНЫМ через shell-фолбэк", () => {
    const t = renderCapabilityPassport({ ...base, extensionConnected: false });
    expect(t).toContain("shell-фолбэком");
    expect(t).not.toMatch(/browser_open[^.]*откажут/); // ложное «недоступно» — тоже нечестность
  });

  it("🔴 длинная строка каналов НЕ вытесняет строки «не предлагай» (адверс-ревью 2026-09-01)", () => {
    // Живой сценарий находки: расширение отвалилось (его строка длинная), плюс реальная строка каналов
    // ~430 символов — паспорт перевалил за кап, и глобальный slice с ХВОСТА уносил обе строки честности.
    // Владелец просил портфель, модель обещала Тинькофф, которого нет. Порядок деградации обязан быть
    // обратным: каналы восстановимы через app_channels, а запрет «не предлагай» — нет.
    const channels =
      "Программные каналы (API/CLI/протокол вместо кликов) есть у: Blender, FFmpeg, Git, Steam, Telegram Desktop, " +
      "OBS Studio, Visual Studio Code, Ollama и ещё 4; встроенных утилит Windows: 7; сетевых сервисов 3 " +
      "(Московская биржа (ISS), Погода (Open-Meteo), ЦБ РФ: курсы валют); ещё 4 сервисов заработают после " +
      "разовой настройки владельцем — не обещай их как готовые — детали инструментом app_channels.";
    const t = renderCapabilityPassport({ ...base, extensionConnected: false, tinkoffToken: false, obsConfigured: false, appChannels: channels });
    expect(t.length).toBeLessThanOrEqual(1101);
    expect(t, "потерян запрет предлагать Тинькофф").toContain("не предлагай");
    expect(t, "потеряна строка про OBS").toContain("obs_request");
    expect(t, "потеряна строка про веб-поиск").toContain("поиск работает");
  });

  it("строка каналов помещается целиком, когда место есть", () => {
    const t = renderCapabilityPassport({ ...base, appChannels: "Программные каналы есть у: Steam — детали инструментом app_channels." });
    expect(t).toContain("Программные каналы есть у: Steam — детали инструментом app_channels.");
  });
});
