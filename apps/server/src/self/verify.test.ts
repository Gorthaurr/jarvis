// Проверка собственной правки: «не запустилось» и «не дождались» ≠ «упало» (ревью волны I).
import { describe, expect, it } from "vitest";
import { runCheck, toolchainAvailable } from "./verify.js";

describe("runCheck — честный статус прогона", () => {
  it("успешная команда → ok:true", async () => {
    const r = await runCheck("echo", "node", ["-e", "process.exit(0)"], "apps/server");
    expect(r.ok).toBe(true);
  });

  it("команда упала → ok:false (это красный прогон, чинить код)", async () => {
    const r = await runCheck("fail", "node", ["-e", "process.exit(1)"], "apps/server");
    expect(r.ok).toBe(false);
  });

  /**
   * 🔴 На Windows под shell отсутствующая команда неотличима от упавшей проверки: cmd.exe отдаёт
   * обычный код 1, а своё сообщение печатает в OEM-кодировке (нечитаемо из Node). Поэтому
   * доступность инструмента выясняется ОТДЕЛЬНОЙ пробой — иначе сломанная среда выглядела бы как
   * сломанный код, и Джарвис пошёл бы «чинить» исправное.
   */
  it("проба тулчейна: несуществующая команда → недоступна", async () => {
    expect(await toolchainAvailable("заведомо-нет-такой-команды-jarvis")).toBe(false);
  });

  it("проба тулчейна: node доступен", async () => {
    expect(await toolchainAvailable("node")).toBe(true);
  });
});
