import type { ToolCase } from "../case-format.js";
import { cases as group1 } from "./sample-desktop.js";
import { cases as group0 } from "./sample-server.js";

export const cases: ToolCase[] = [...group0, ...group1];
