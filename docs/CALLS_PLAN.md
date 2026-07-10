# Джарвис в звонках/голосовых — план (воркфлоу 2026-06-19, сверено с кодом)

## ТРЕБОВАНИЕ ГОЛОСА (Антон)
Голос в звонках И в голосовых — **ТОЛЬКО filipp** (текущий Yandex-голос, как сейчас в обычной речи).
Реализуется само: и MVP, и голосовые переиспользуют существующий `yandex-tts` (filipp) БЕЗ изменений —
просто маршрутизируем тот же аудиопоток в вирт.микрофон / в ogg для voice note. Никакой смены голоса/клона.

## Расклад
- **Живой двусторонний диалог в звонке НЕ вытянет сейчас** (architectural): ответ Opus 2–13с + боль #1
  (Deepgram WS churn) + TTS ~0.4с → пауза на ответ убивает беседу. Реалистично: «зачитать заготовку /
  ответить на одну реплику», не диалог. Двусторонний — только ПОСЛЕ persistent STT WS.

## MVP (узкий, без нативного кода, без TG-голоса): «Джарвис говорит в звонок как микрофон»
Снимает 3 HIGH-блокера разом (нет захвата → нет эхо-петли; нет двустороннего → нет latency-проблемы;
нет TG-голоса → не нужен GramJS).
1. Юзер 1 раз ставит **VB-CABLE** (прямой инсталлятор `VBCABLE_Setup_x64.exe -i -h` через RunAs; choco/winget
   НЕ годятся — проверено; один клик доверия драйверу VB-Audio + `Restart-Service Audiosrv`). В звонилке
   микрофон = `CABLE Output`, выключить встроенный шумодав (Discord Krisp/Zoom NS режут синтез), выход
   звонилки оставить РЕАЛЬНЫМ (иначе вой).
2. **`apps/client/renderer/audio.ts`**: новая фабрика `makeSinkPlayer(sinkIds)` (DI уже готов — `PlayerFactory`,
   `defaultPlayer`, `AudioPlayback(createPlayer)`). Через `HTMLMediaElement.setSinkId` (Electron 33=Chromium 130,
   из коробки). **`renderer.ts:~317`** (место `new AudioPlayback()`): `new AudioPlayback(makeSinkPlayer([cableInputId, ""]))`
   — dual-output: кабель собеседнику + "" (системный дефолт) Антону. `cableInputId` резолвить
   `enumerateDevices()` по `label ~ /CABLE Input/i` ПОСЛЕ `AudioCapture.start()` (до — метки пустые).
   Хранить LABEL-подстроку в `settings-store` (deviceId нестабилен между ребутами), резолвить заново.
   `server/yandex-tts.ts` НЕ трогать.
3. **Согласие (красная зона §14):** новый НЕ-кешируемый `kind:"call_mode"` confirm (в отличие от
   `consent.ts approveSend` — он помнит навсегда). Каждый вход = строгий `requestConfirm` («Включить режим
   звонка? Буду говорить твоим голосом в [app]. Скажи „да, режим звонка“»). Орб «IN CALL — говорю твоим
   голосом» (`sendClientState`). **Стоп-слово** «Джарвис, выйди из звонка» — перехват ДО LLM, ТОЛЬКО на
   верифицированный голос владельца (`voice/speaker/verifier.ts`) → `cancelTts()` + отключить кабель + idle.
   Дублировать кнопкой/хоткеем. Append-only `data/call-audit.jsonl`. Fail-closed; запрет в проактивных §20;
   авто-таймаут режима ~30мин. Юридика: предупреждать про запись речи собеседника (152-ФЗ).

## Порядок дальше
1. **Persistent Deepgram WS + KeepAlive** (боль #1) — пререквизит долгоживущего call-STT И фикс «медленно/не слышит».
2. **Слух собеседника** — `desktopCapturer` screen-loopback + ВТОРОЙ STT (`CallListener`, &lt;150 строк, отдельный
   `stt.open`, реплики собеседника → `working.ts` роль `remote`) + **анти-эхо**: TTS→CABLE Input, захват с
   устройства БЕЗ кабеля + echo-mute call-STT по `speak_start/done` + анти-self отпечаток (`verifier`).
   `AudioFrame.channel:'mic'|'call'`.
3. **Production-захват** — WASAPI process-loopback звонилки через `apps/sidecar-win` (NAudio; чистая развязка от TTS).
4. **Turn-taking** — `remoteSpeaking`-гард в `pipeline.ts maybeDrainSpeech` (рядом с `userSpeaking`) + barge-in
   собеседника → `cancelTts()`. Никакой новой машины состояний — переиспользовать `pipeline`/`turn.ts`.
5. **Telegram голосовое** — БЛОКЕР: `packages/userbots/src/index.ts:67` заглушка. Нужен GramJS-клиент
   (apiId/apiHash + StringSession в safeStorage) → `sendFile` c `DocumentAttributeAudio{voice:true,duration,
   waveform}`; синтез mp3 → `ffmpeg -c:a libopus -b:a 48k -ac 1 -application voip out.ogg` (ffmpeg есть, TOOL_SPECS).
   Новый tool `telegram_send_voice{to,text}` под `confirmSendOnce`. Fallback: аудио-ФАЙЛ через webK + честно
   сказать «это не кружок».

Полный синтез: task `w6fy1lyi9`.
