import { inject } from "vitest";
import { isolateTestTemp } from "./vitest-temp.js";

isolateTestTemp(inject("jarvisTestTempRoot"));
