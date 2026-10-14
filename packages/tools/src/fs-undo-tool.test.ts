import { describe, expect, it } from "vitest";
import { ACTUATOR_TOOL_BY_KIND, COLD_TOOL_NAMES, TOOLS_BY_NAME, pickBySchema } from "./index.js";

describe("восстановление выполняется по клиентскому снимку", () => {
  it("схема разрешает лишь операцию и id, отсекает произвольные байты/путь и самоодобрение модели", () => {
    expect(ACTUATOR_TOOL_BY_KIND["fs.undo"]).toBe("fs_undo");
    const schema = TOOLS_BY_NAME.fs_undo!.input_schema;
    expect(pickBySchema(schema, { op: "restore", id: "snapshot", path: "secret", content: "forged", approval: true }))
      .toEqual({ op: "restore", id: "snapshot" });
    expect(COLD_TOOL_NAMES.has("fs_undo")).toBe(true);
  });
});
