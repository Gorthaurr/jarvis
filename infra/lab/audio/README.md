# Аудио-стенд лаборатории: WAV -> настоящий слух клиента -> сервер -> озвучка

Агент Claude подаёт WAV (или фон) и видит, что сделал слух Джарвиса, что распознал STT сервера, что ответил мозг и что
озвучено. Настоящее здесь: `AudioCoordinator` + sherpa KWS «Джарвис» + Silero VAD из `apps/client/main` (модели
`~/.jarvis/models`; нет моделей -> честный отказ с причиной, не тихий skip). Сервер и транспорт — через `LabClient`.

```ts
const server = await startLabServer({ stt: "deepgram", brain: "off" }); // stt:"mock" не распознаёт речь
const client = await connectLabClient({ server, desktop: createFakeDesktop(), keepAudio: true }); // keepAudio — чтобы звук сохранялся
const stand = await createAudioStand({ client });
const r = await stand.sayWav("apps/client/test-audio/pos_filipp_1.wav");
r.hearing   // { wakeFired, gateOpened, rescueSent, rescueVerdict?, log[] }
r.transcript // что распознал STT сервера (chat role=user)
r.answer, r.speech, r.speechFiles // ответ, озвучка (чанки/байты) и сохранённые файлы (.mp3/.wav)
await stand.feedNoise("tv", 6000) // ok:true только если слух промолчал и в облако не ушло ни кадра
```

## Как устроено
- `mic-model.ts` — тракт как в renderer: pre-gain -> `tanh(6x)` (makeup) -> Int16 -> кадры по 320 сэмплов + хвост тишины 1 с.
- `hearing-rig.ts` — `AudioCoordinator.ingest()` (граница renderer->main); `sendFrame/sendVad/sendRescue` -> `LabClient`
  (`audio.frame` base64, `audio.vad`, `audio.wake_rescue`). Часы: realtime = стенные, fast = виртуальные.
- `feedback.ts` — `client.state` -> `setServerState`, `wake.rescue.result` -> `onWakeRescued`, `speak.chunk` -> `fake-player.ts`.
- `fake-player.ts` — «динамик»: `audio.playback{active}` и `audio.played{gen,ts}` серверу (иначе очередь речи и m2e врут),
  звук в файл через `speech-store.ts`; длительность mp3/wav/pcm считается (`audio-format.ts`).
- `event-cursor.ts` — курсор по журналу-кольцу LabClient (5000 событий; индекс `length` после переполнения врёт).
- `noise.ts` — тишина/комната/«ТВ» (синтетика, seed). `corpus*.ts` — варианты громкости/шум/обрезка/near-miss ИЗ
  `apps/client/test-audio` без ключей; `CORPUS_REPORT.md` — отчёт (обновить: `apps/server/node_modules/.bin/tsx infra/lab/audio/report-cli.ts`).
- `mock-client.ts` — сценарный «сервер» для тестов без лаб-сервера (`ringMax`, `stripAudio`).

## Режимы
- `realtime` (деф.) — кадры в реальном темпе, годится для серверных таймингов и живого STT.
- `fast` (`realtime:false`) — виртуальные часы клиента, без пауз: ТОЛЬКО для слуха/мока. Таймеры сервера и `GateCloser`
  остаются реальными; пачка кадров быстрее реального времени искажает эндпоинтинг сервера.

## Тесты
`node_modules/.bin/vitest run --root infra/lab audio` (из корня репо). `stand.live.test.ts` использует платный Deepgram
и запускается только при явном `LAB_LIVE_DEEPGRAM=1` и наличии ключа (окружение или `.env` владельца, пробросом в env
процесса сервера, в файлы не пишется). Без разрешения ключ не читается, тест пропускается с причиной.
`LAB_SKIP_LIVE=1` отключает его даже при явном разрешении; бесплатные локальные тесты не требуют opt-in.

## Находки живого прогона (не подгонка — наблюдение)
1. **Ход, у которого к `speech_end` пуст interim STT, гибнет.** Живьём 2 из 3 первых попыток «Джарвис, открой блокнот» терялись
   (сервер оставался в `listening`, `chat{user}` не приходил). Гипотеза по чтению кода (изоляцией НЕ доказана): после
   `speech_end` пайплайн закрывает стрим (`close_stt` -> запечатывание Deepgram, до 3 с), а кадры хвоста тишины в
   `listening && !sttStream` открывают НОВЫЙ стрим (`pipeline.ts:855-862 ensureStt`), и `beginTurn -> abandonTurn`
   (`deepgram.ts`) молча глушит запечатываемый ход. Со «свежим» interim (тёплый сокет, Deepgram успел) ход идёт спекулятивно и не теряется.
   В `apps/**` не правил — это дефект сервера, а не стенда.
2. `LabClient` по умолчанию вырезает `audio` из `speak.chunk` в журнале; для сохранения звука нужен `keepAudio:true`
   (расширение lib/client). Без него стенд считает байты по `audioBytes` и пишет в `hearing.log` предупреждение.
3. Корпус — нормализованные TTS-WAV (пик 0,6–0,7), живой мик даёт 0,01–0,04: числа KWS в отчёте оптимистичнее живых
   (живой промах ~50%, см. CHANGELOG). `preGain` — явная ручка, не молчаливая подгонка.

## Не покрыто
Живая акустика, AEC, задержки динамика, голос владельца, барж-ин на живом звуке; подавление отставших чанков после
barge-in (400 мс) и дренаж PCM-таймеры плеера (DRAIN 11 с / ORPHAN 12 с) не моделируются.
