# sidecar-win — Нативный Windows-сайдкар (§6, §18)

> **Важно (§18):** Это самый трудоёмкий компонент всей системы.
> UIAutomation API непредсказуем на legacy-приложениях (WPF, Win32, некоторые Electron-окна).
> Per-Monitor DPI Awareness V2 требует тщательного тестирования на конфигурациях 125% / 150%.
> Заложи не менее 2–3 спринтов на доводку.

> **Примечание (§1):** nut.js в этом проекте **не используется**.
> Весь синтетический ввод идёт через Win32 `SendInput` напрямую (P/Invoke) с маркером
> `dwExtraInfo = 0x4A415256` («JARV») для различения синтетики от физического ввода (§6).

---

## Архитектура

```
Electron (apps/client)
        │  stdio (JSON-line)
        ▼
SidecarWin.exe  (один процесс)
  ├─ Program.cs        — цикл stdin/stdout
  ├─ UiaGrounder.cs    — UIAutomation: ground / invoke / read
  ├─ InputSynthesizer.cs — SendInput: click / type / key
  └─ Ipc.cs            — модели запроса/ответа
```

Ключевое преимущество: UIAutomation и SendInput живут **в одном процессе**.
Это устраняет IPC-гонку «нашли элемент → успели кликнуть» (§6).

---

## Сборка

### Требования
- .NET SDK 8.0+ (скачать: https://dot.net)
- Windows 10/11 x64

### Debug (быстрая проверка)
```powershell
# Из корня monorepo:
dotnet build apps/sidecar-win -c Debug
```

### Release — self-contained single-file EXE (~70–120 МБ)
```powershell
# Из корня monorepo:
dotnet publish apps/sidecar-win `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o dist/sidecar-win
```

Итоговый файл: `dist/sidecar-win/SidecarWin.exe`

---

## Запуск из Electron-клиента

```typescript
// apps/client/src/main/sidecar.ts (фрагмент)
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

const bin = path.join(process.resourcesPath, 'sidecar-win', 'SidecarWin.exe');
const proc = spawn(bin, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

// Читаем ответы построчно
const rl = readline.createInterface({ input: proc.stdout! });
rl.on('line', (line) => {
  const resp = JSON.parse(line); // { id, ok, data } | { id, ok, error }
  // ... передать в ожидающий Promise по resp.id
});

// Пишем запросы
function sendRequest(op: string, args: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  const line = JSON.stringify({ id, op, args }) + '\n';
  proc.stdin!.write(line);
  return new Promise((resolve, reject) => { /* ... сохранить по id ... */ });
}
```

### Упаковка в Electron
В `electron-builder.yml`:
```yaml
extraResources:
  - from: dist/sidecar-win
    to: sidecar-win
    filter: ['**/*.exe']
```

---

## Протокол JSON-line

### Запрос
```json
{ "id": "<uuid>", "op": "<операция>", "args": { ... } }
```

### Успешный ответ
```json
{ "id": "<uuid>", "ok": true, "data": { ... } }
```

### Ответ с ошибкой
```json
{ "id": "<uuid>", "ok": false, "error": "Описание ошибки" }
```

---

## Операции

| op | args | data | Статус |
|----|------|------|--------|
| `ground` | `role`, `name?`, `scope?` | `GroundResult{handle,x,y,w,h,name,role}` | Работает |
| `invoke` | `handle`, `pattern`, `value?` | `{success:true}` | Работает |
| `click` | `x`, `y`, `button?` | `{success:true}` | Работает |
| `type` | `text` | `{success:true,length}` | Работает |
| `key` | `combo` | `{success:true,combo}` | Работает |
| `read.selection` | `handle?` | `{text}` | Работает |
| `read.window` | `pid?`, `maxChars?` | `{text,truncated}` | Работает |
| `raw-input.subscribe` | `enable` | `{subscribed:false}` | TODO(M2) |

### Роли для `ground`
Строковые псевдонимы UIA ControlType: `button`, `checkbox`, `combobox`, `edit`, `hyperlink`,
`list`, `listitem`, `menu`, `menubar`, `menuitem`, `radiobutton`, `slider`, `tab`, `tabitem`,
`text`, `tree`, `treeitem`, `window`, `pane`, `document`, `datagrid`, `dataitem` и др.

### Паттерны для `invoke`
`invoke` | `setValue` | `select` | `toggle` | `expand` | `scroll`

### Клавишные комбо для `key`
Модификаторы: `ctrl`, `shift`, `alt`, `win`.  
Пример: `"ctrl+shift+s"`, `"win+r"`, `"alt+F4"`, `"ctrl+c"`.

---

## TODO

- **TODO(M1)**: Метод `GetBbox(handle)` в `UiaGrounder` — fallback-клик по дескриптору без координат.
- **TODO(M2)**: `raw-input.subscribe` — low-level hook `WH_KEYBOARD_LL` / `WH_MOUSE_LL`:
  фильтрация по `dwExtraInfo == SyntheticMarker` (§6), уведомление Electron о user-takeover.
  Требует message loop в отдельном потоке.
- **TODO(M2)**: Полный DPI-маппинг для multi-monitor конфигураций с разными масштабами.
- **TODO(M3)**: Поддержка `UIA_IsOffscreenPropertyId` — пропуск невидимых элементов в `ReadWindow`.
- **TODO(M3)**: Кэш UIAutomation-элементов с инвалидацией по событию `AutomationElement.StructureChangedEvent`.
