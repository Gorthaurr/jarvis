// W2 (П4): жест act для долга ОТПРАВКИ (send-gesture.ts) — новые формы W2 не должны проходить мимо сверки исхода:
//  - type{enter:true} — набор И коммит одним вызовом (как input_batch «type → Enter»);
//  - triple по «Отправить» — тот же клик-коммит;
//  - серия act{steps} — разбирается как берст: набор → коммит в одном вызове = долг сверки исхода, серия,
//    кончающаяся набором, оставляет текст в поле (следующий коммит станет отправкой).
import { actGesture } from "./util.js";

type Gesture = { commit: boolean; composes: boolean };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Одиночный act (не серия): commit — клик/Enter/набор с enter; composes — набор текста. */
export function actCallGesture(input: unknown): Gesture {
  const i = isObj(input) ? input : {};
  if (Array.isArray(i.steps)) return { commit: false, composes: false }; // серия — через inspectActSeries
  const g = actGesture(i);
  const verb = typeof i.do === "string" ? i.do : "click";
  return { commit: g.commit || verb === "triple" || (g.composes && i.enter === true), composes: g.composes };
}

/** Серия act{steps} в форме берста (inspectBatchSteps): пара набор → коммит, есть ли коммит, кончается ли набором. */
export function inspectActSeries(input: unknown): { committed: boolean; endsComposed: boolean; hasSend: boolean } {
  const steps = isObj(input) && Array.isArray(input.steps) ? input.steps.filter(isObj) : [];
  let composedIdx = -1;
  let committed = false;
  let hasSend = false;
  let endsComposed = false;
  steps.forEach((s, i) => {
    if (s.do === "capture" || s.do === "wait" || s.do === "hover" || s.do === "scroll") return; // ни набора, ни коммита
    const g = actCallGesture(s);
    if (g.composes) composedIdx = i;
    if (g.commit) {
      hasSend = true;
      if (composedIdx >= 0 && composedIdx <= i) committed = true; // type{enter:true} — набор и коммит одним шагом
    }
    endsComposed = g.composes && !g.commit;
  });
  return { committed, endsComposed, hasSend };
}

/** act — серия шагов? */
export const isActSeries = (name: string, input: unknown): boolean => name === "act" && isObj(input) && Array.isArray(input.steps);
