import type { ToolCase } from "../case-format.js";
import { cases as group0 } from "./comm-telegram-delivery.js";
import { cases as group1 } from "./comm-telegram-fallback.js";
import { cases as group2 } from "./comm-telegram-resend.js";

export const cases: ToolCase[] = [...group0, ...group1, ...group2];
