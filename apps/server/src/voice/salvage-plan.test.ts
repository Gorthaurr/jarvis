/** Таблица решений salvage (salvage-plan.ts): что из спасённой реплики озвучивать и каким происхождением. */
import { describe, expect, it } from "vitest";
import { planSalvage } from "./salvage-plan.js";

describe("planSalvage", () => {
  const base = { silenced: false, spokeAlready: false, addressed: true };

  it("глушение, частично прозвучавшая речь и ack промоушена — только текст, без голоса", () => {
    expect(planSalvage({ ...base, silenced: true }).voice).toBe(false);
    expect(planSalvage({ ...base, spokeAlready: true }).voice).toBe(false);
    expect(planSalvage({ ...base, ack: true }).voice).toBe(false);
    expect(planSalvage({ ...base, ack: true, origin: "proactive" }).voice).toBe(false);
  });

  it("проактивный done и ход, принятый окном без «Джарвис», — проактив; адресованный ход — ответ владельцу", () => {
    expect(planSalvage({ ...base, origin: "proactive" })).toEqual({ voice: true, origin: "proactive" });
    expect(planSalvage({ ...base, addressed: false })).toEqual({ voice: true, origin: "proactive" });
    expect(planSalvage({ ...base, addressed: false, origin: "user-turn" })).toEqual({ voice: true, origin: "proactive" });
    expect(planSalvage(base)).toEqual({ voice: true, origin: "user-turn" });
  });
});
