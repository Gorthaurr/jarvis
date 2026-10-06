/** Каталог шагов раннера. Профили вложены: quick ⊂ verify ⊂ full — состав задан полем profiles у каждого шага. */
import { CORE_STEPS } from "./steps-core.js";
import { FLAKE_STEPS } from "./steps-flake.js";
import { SLOW_STEPS } from "./steps-slow.js";
import { TEST_STEPS } from "./steps-tests.js";
import type { ProfileName, Step } from "./types.js";

/** Порядок: дешёвое и быстро краснеющее раньше (typecheck → гейты → тесты → тяжёлое). */
export const ALL_STEPS: Step[] = [...CORE_STEPS, ...TEST_STEPS, ...FLAKE_STEPS, ...SLOW_STEPS];

export const PROFILES: ProfileName[] = ["quick", "verify", "full"];

export function stepsFor(profile: ProfileName, all: Step[] = ALL_STEPS): Step[] {
  return all.filter((s) => s.profiles.includes(profile));
}
