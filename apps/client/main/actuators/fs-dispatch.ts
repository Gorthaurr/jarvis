import type { ActionCommand } from "@jarvis/protocol";
import * as fs from "./fs.js";
import { fileUndo } from "./fs-undo.js";

/** Единый файловый маршрут для настоящего клиента и проверок на временных файлах. */
export async function dispatchFileCommand(cmd: ActionCommand): Promise<unknown> {
  switch (cmd.kind) {
    case "fs.read": return fs.readFile(cmd.path, cmd.maxBytes, { offset: cmd.offset, lines: cmd.lines, tail: cmd.tail });
    case "fs.write": return fs.writeFile(cmd.path, cmd.content, cmd.createDirs);
    case "fs.edit": return fs.editFile(cmd.path, cmd.old, cmd.new, cmd.replaceAll);
    case "fs.append": return fs.appendFile(cmd.path, cmd.content);
    case "fs.undo": return fileUndo(cmd.op, cmd.id);
    case "fs.list": return fs.listDir(cmd.path, cmd.recursive);
    case "fs.delete": return fs.deleteEntry(cmd.path, cmd.recursive);
    case "fs.move": return fs.moveEntry(cmd.from, cmd.to);
    case "fs.mkdir": return fs.makeDir(cmd.path);
    case "fs.search": return fs.search(cmd.root, cmd.query, cmd.inContent, cmd.maxResults,
      Array.isArray(cmd.ignore) ? { ignore: cmd.ignore.map(String) } : undefined);
    default: throw new Error(`Файловый маршрут не поддерживает ${cmd.kind}`);
  }
}
