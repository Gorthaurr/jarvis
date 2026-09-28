# voice-audio — карта звука: микрофон → KWS/VAD → гейт → WS → STT → wake-гейт → агент → TTS → плеер

Область: `apps/server/src/voice/*`, клиент `apps/client/main/{audio,hearing,vad,wakeword}`, `apps/client/renderer/audio*.ts`,
стыки `transport/index.ts`, `gateway/router-ws.ts`, `gateway/wake-rescue-route.ts`. Всё ниже прочитано в коде; живьём ничего не гонял
(задача — только чтение). Что не проверено — помечено «не проверено».

## 1. КАК РАБОТАЕТ

### 1.1 Сквозной поток (обычный ход по голосу)
```
[mic] getUserMedia(AEC вкл, NS/AGC выкл) -> WaveShaper tanh(x*6) -> AudioWorklet 16 кГц mono -> кадр 320 сэмпл (20 мс)   renderer/audio.ts:82,111,  audio-worklet.js
  -> IPC pushPcm -> main AudioCoordinator.ingest()                                                                     main/index.ts:527, audio/index.ts:277
       ГЕЙТ ЗАКРЫТ: кадр в кольцо preroll (45 кадров = 0,9 с) + sherpa KWS.process()  [+ WakeMissMonitor.frame(): энерг. VAD, «промах»]
         KWS hit -> openGate("wakeword") -> sendVad("wake_local") -> replay preroll через streamFrame() -> дальше живой поток
       ГЕЙТ ОТКРЫТ: streamFrame(): vad.process() -> sendVad(speech_start|speech_end); sendFrame(pcm) ВСЕГДА
  -> Transport: audio.vad / audio.frame (base64 JSON по WS, ~50 msg/с)                                                 transport/index.ts:208-227
  -> server router-ws dispatch: audio.frame -> voice.onAudioFrame; audio.vad -> voice.onVadEvent                       router-ws.ts:1110-1119
  -> VoicePipeline: idle+кадр = wake -> ensureStt() (Deepgram persistent WS, interim) -> speech_end -> TurnDetector
       (семантика+тишина 280..850 мс, либо speech_final провайдера) -> endpointTurn (спекулятивно по interim)
  -> gateWake(): нормализатор лексики -> диктор-гейт -> «Джарвис»/локальный wake/second-chance/катящееся окно/строгий шум -> дедуп 8 с
  -> reduce(transcript_final) => thinking + call_agent -> runAgentStreaming -> onUserTurnStream (handleUserText, Agent SDK)
  -> PhraseSpeaker: пофразный TTS (Yandex v1 mp3 | v3 pcm16 | ElevenLabs) -> emitSpeakChunk -> speak.chunk (base64, тег gen=turnSeq)
  -> client AudioPlayback (очередь озвучек / PcmLivePlayer) -> audio.playback{active} и audio.played{gen,ts} назад серверу
  -> speak_done -> listening + follow-up (12 с) -> idle => клиент: state=idle + локальный wake => closeGate (звук в облако не идёт)
```
`client.state` от сервера (idle/listening/thinking/speaking) — единственная синхронизация: `transport.on("serverState")` -> `audio.setServerState` (main/index.ts:334-337).

### 1.2 Клиент: файлы и роль
| Файл | Роль |
|---|---|
| `main/audio/index.ts` (540 стр.) | `AudioCoordinator`: гейт §0.6, preroll, wake->openGate, barge-in (устойчивость по времени + адаптивный порог по фону), mute/PTT/hold, закрытие по idle/тишине |
| `main/audio/gate-closer.ts` | два таймера: idle 10 с (сдвигается речью) + cap 30 с (речью не сдвигается) |
| `main/audio/mic-control.ts` | воля владельца: kill-switch; activate после mute = push-to-talk |
| `main/audio/ptt-hotkey.ts` | глобальная `Control+Alt+J` (константа, не env) |
| `main/audio/wake-miss.ts` + `segment-recorder.ts` | при закрытом гейте отдельный энерг. VAD (порог 700, hangover 500 мс) ищет «речь без wake»; кандидат 0,45..4 с и peak>=6000 -> подстраховка |
| `main/audio/rescue-link.ts` | отправка кандидата, эхо-хвост 1,5 с после TTS, отмена при mute (окно 6 с), открытие гейта по вердикту сервера (bare -> replay preroll) |
| `main/hearing/sherpa-hearing.ts` | реальные движки: KWS zipformer gigaspeech 3.3M (англ. BPE «▁JA R VI S»…, порог #0.2) + Silero VAD v5; модели `~/.jarvis/models` (ASCII!) |
| `main/vad/index.ts` | `EnergyVad` (фолбэк; онсет 3 кадра, hangover, потолок 1000 кадров + адаптивный порог) |
| `main/wakeword/index.ts` | интерфейс `IWakeWord`, `MockWakeWord` (ready=false -> гейт открыт всегда, wake по тексту облака) |
| `renderer/audio.ts` (684 стр.) | `AudioCapture` (mic + watchdog mute/ended + ретрай 1->30 с), `AudioPlayback` (очередь озвучек, PCM live, gen-дедуп mouth-to-ear, подавление отставших чанков 400 мс), `PcmLivePlayer`, `wavFromPcm16` |
| `renderer/capture-starter.ts` | стартовый подъём микрофона с тем же бэкоффом; `activate()` только после реального подъёма |
| `renderer/renderer.ts:136-260` | связка: speak.chunk -> playback.enqueue (если не outputMuted), bargeIn -> playback.stop, кнопки mic/mute |

### 1.3 Сервер: файлы и роль
| Файл | Роль |
|---|---|
| `voice/pipeline.ts` (1795 стр.) | `VoicePipeline` — оркестратор: STT-жизнь, эндпоинт, gateWake, агент, TTS, очередь озвучки, follow-up, salvage, earcon |
| `voice/state.ts` | чистый редьюсер `reduce()`: idle/listening/thinking/speaking; события wake, speech_*, transcript_final, speak_*, barge_in, followup_timeout, stop, mute |
| `voice/turn.ts` | `TurnDetector`+`HeuristicTurnDetector`: 850/280 мс, порог 0.75 (env `JARVIS_TURN_*`); `onProviderEndpoint` порог 0.60 |
| `voice/wake.ts` | текстовый wake: WAKE_RE + fuzzy lev<=2, `stripWakeDetailed` (B-F12), near-miss, second-chance словарь, шумовые слова |
| `voice/wake-strict.ts`, `wake-rescue.ts`, `pipeline-rescue.ts` | подстраховка: строгое обращение, судья с лимитами, шов к пайплайну (эпоха сброса) |
| `voice/speak-session.ts` | `PhraseSpeaker`: серийный синтез фраз, один speak_start/один speak_done |
| `voice/lexicon.ts` | пост-STT латиница->кириллица по лексикону (TTL 60 с, синхронный `normalize`) |
| `voice/earcon.ts`, `filler-cache.ts` | WAV-тон приёмки (160 мс), прекеш филлеров («Секунду, сэр.» — по умолчанию ВЫКЛ) |
| `voice/drop-notice.ts`, `speech-pick.ts`, `salvage-plan.ts` | честное «не успел проговорить», порядок очереди, план голоса спасённой реплики |
| `voice/first-answer.ts`, `latency.ts`, `turn-latency.ts`, `m2e-snapshots.ts` | метрики: mouth-to-ear, first_answer, стадии |
| `voice/tts-prewarm.ts` | прогрев кеша TTS ack-фразами |
| `voice/speaker/*` + `gateway/voice-enroll.ts` | отпечаток голоса (sherpa CAM++ в сайдкаре), `JARVIS_SPEAKER_GATE=1` — фильтрация, по умолчанию ВЫКЛ; запись голоса доступна всегда |
| `integrations/{deepgram,deepgram-once,whisper-stt,yandex-tts,yandex-tts-v3,elevenlabs,tts-cache,providers}.ts` | провайдеры STT/TTS за `ISttProvider`/`ITtsProvider` |

### 1.4 Состояния и таймеры
Гейт клиента: `closed` -> (`wake`|`PTT`|`rescue`|`hold`|нет-локального-wake) -> `open` -> (`idle сервера`|тишина 10 с|cap 30 с|mute) -> `closed`.
Сервер: `idle -> listening -> thinking -> speaking -> listening(follow-up) -> idle`.

| Клиент | Значение | Сервер | Значение |
|---|---|---|---|
| PREROLL | 45 кадров (0,9 с) | endpoint | 850 мс потолок / 280 мс мин / 0.75 |
| LISTEN_IDLE_CLOSE / HOLD_CAP | 10 с / 30 с (env) | SILENCE_POLL | 150 мс |
| PTT_OPEN | 8 с | LOCAL_WAKE_WINDOW | 8 с |
| BARGE grace/sustain/gap/refractory | 250 / 200 (env) / 120 / 500 мс | окно разговора / follow-up | 8 с (router-ws.ts:701) / 12 с (:700) |
| BARGE порог | 250 (env) и фон x2.5 (env), EMA 0.05 | шум: окно/мин/выход | 30 с / 3 / 1 (env) |
| MAX_PLAYBACK_TAIL | 90 с | second-chance | кулдаун 120 с, ожидание «да» 15 с |
| RESCUE эхо-хвост / отмена | 1,5 с / 6 с | дедуп команды | 8 с |
| mute-watchdog / ретрай | 1,5 с / 1->30 с | очередь озвучки | TTL 120 с, кап 4 |
| PCM drain / orphan | 11 с / 12 с | playback confirm / grace / stale | 1,5 с / 400 мс / 120 с |
| подавление отставших чанков | 400 мс | earcon раздумья | 700 мс |
| | | rescue: интервал / в час / антифон | 1,5 с / 150 / 6 отказов за 120 с -> пауза 5 мин |

### 1.5 Инварианты (нарушение = дефект)
1. §0.6: при локальном wake и закрытом гейте в облако НЕ уходит ничего, кроме одного rescue-фрагмента (только сервер в покое, громко, 0,45..4 с). Текст отвергнутого фрагмента не логируется (`wake-rescue.ts:109`).
2. mute главнее всего: PTT не открывает выключенный микрофон; mute посреди фразы = `speech_cancel`, а не `speech_end` (обрубок не исполняется).
3. Исход озвучки честный: `onOutcome(true)` только на ПЕРВОМ реально ушедшем чанке (pipeline.ts:1643); `cancelTts` закрывает незавершённые исходы `false` (:1671); «стоп»/mute -> `silenceSalvage` — запрещённая реплика не воскресает (:1707).
4. Сырой `speech_start` в thinking ход НЕ отменяет (state.ts:152); отмена — только `barge_in` (устойчивая речь клиента) или явное обращение. Один ход за раз (pipeline.ts:1185).
5. Проактивная речь окно разговора не открывает и не продлевает (SpeechOrigin, pipeline.ts:236, 1618-1626).
6. Одна реплика проходит `gateWake` до двух раз (спекулятивный эндпоинт + поздний финал) — счётчики шума дедуплицируются по `turnSeq` (pipeline.ts:540).
7. Кадр = 320 сэмплов @16 кГц; от этого зависят PREROLL (45) и `WakeMissMonitor` (мс считаются по сэмплам, wake-miss.ts:83).

## 2. ВОЗМОЖНОСТИ
Полный машиночитаемый список — `voice-audio.json` (`capabilities`, 58 шт.). Сводка по группам:

| Группа | id (примеры) | Вход | Чем запускается |
|---|---|---|---|
| Захват | `client.capture.mic`, `.resilience`, `.boot` | `renderer/audio.ts:56`, `capture-starter.ts:53` | старт клиента, событие mute/ended трека |
| Слух | `client.wake.kws`, `client.vad.silero`, `client.vad.energy`, `client.wake.fallback-mock` | `hearing/sherpa-hearing.ts:101,141`, `vad/index.ts:65` | кадр PCM |
| Гейт | `client.gate.privacy`, `.close-timers`, `.close-on-idle`, `client.mute.kill-switch`, `client.hold.enroll` | `audio/index.ts:277,341,361` | кадр / client.state / кнопка |
| Ручной вход | `client.ptt.button`, `client.ptt.hotkey` | `audio/index.ts:198,231`, `ptt-hotkey.ts:21` | кнопка, Ctrl+Alt+J |
| Barge-in | `client.bargein`, `client.playback.tail-tracking` | `audio/index.ts:469,395` | кадр во время TTS |
| Подстраховка | `client.wakemiss.telemetry`, `client.wake.rescue-*`, `server.wake.rescue*` | `wake-miss.ts:47`, `rescue-link.ts:44`, `wake-rescue.ts:52` | кадры при закрытом гейте |
| Плеер | `client.playback.queue/pcm-live/m2e-ack/volume-mute-stop` | `renderer/audio.ts:267,552` | speak.chunk |
| Транспорт | `client.transport.audio` | `transport/index.ts:208-236` | все аудио-сообщения |
| STT/эндпоинт | `server.stt.stream`, `server.endpointing`, `server.state-machine` | `pipeline.ts:1084,970`, `state.ts:67`, `turn.ts:98` | кадры/VAD-события |
| Адресация | `server.wake.text-gate`, `.strip`, `.local-window`, `server.noisy-mode`, `server.speaker.gate`, `server.lexicon.normalize` | `pipeline.ts:450,390,881`, `wake.ts:208` | финал STT |
| Ответ | `server.agent.turn`, `server.tts.*`, `server.followup-window`, `server.salvage`, `server.quiet` | `pipeline.ts:1178,1595,1739,1720,645` | transcript_final, speakQueued, stop |
| Очередь речи | `server.speech.queue`, `.playback-gate`, `server.drop-notice`, `server.earcon.*`, `server.filler` | `pipeline.ts:700,1380,1532,1495,1553` | напоминания, фон, время |
| Метрики | `server.metrics.*` | `pipeline.ts:778`, `first-answer.ts:25` | audio.played |
| Dev | `server.dev.vad-inject`, `server.dev.voice-driver` | `gateway/server.ts:500`, `_jarvis_voice.mjs` | HTTP (JARVIS_DEV_HTTP=1), скрипт |

## 3. ШВЫ (seams) — где касаемся мира и как подменять
| Шов | Где | Как подменить в лаборатории |
|---|---|---|
| Микрофон/AEC/усиление | `AudioCapture` (DOM: getUserMedia, AudioWorklet) | НЕ подменяем в Node: подаём готовые кадры в `AudioCoordinator.ingest()` (шов = граница renderer->main, `IPC.pushPcm`). Усиление `micMakeupCurve` (audio.ts:21, НЕ экспортирована) надо воспроизвести в стенде — иначе пороги (peak 6000, barge 250) не те |
| Движки слуха | `AudioCoordinatorDeps.wakeword/vad`, `setEngines()` (audio/index.ts:267) | реальные: `createSherpaHearing({dir})`; фейки: `IWakeWord`/`IVad` (образец — `ScriptVad`, index.test.ts:53) |
| Часы клиента | `deps.now` (barge, grace, rescue, wake-miss) | инжектируется; но `GateCloser` и `AudioCapture` используют РЕАЛЬНЫЕ `setTimeout` -> `vi.useFakeTimers()` |
| Клиент->сервер | `deps.sendFrame/sendVad/sendRescue`, `Transport` (только `ws`, без Electron) | записать в массив (утверждения) ИЛИ настоящий `Transport` к настоящему серверу с `clientVersion="lab-test"` (попадает под `isDevSession`, dev-session.ts) |
| Плеер | `PlayerFactory` (audio.ts:207), `AudioPlayback(createPlayer,onActive,onFirstAudioPlayed)` | фейковый `PlayerFactory` (тесты audio.test.ts); для `format:"pcm16"` нужен `AudioContext` — в Node подложить заглушку (в audio.test.ts она есть) |
| Сервер: провайдеры | `VoicePipelineDeps.stt/tts` (`ISttProvider`/`ITtsProvider`), `BrainProviders` (router-ws) | `MockSttProvider(scripted)`, управляемый `CtrlStt` (`gateway/test-support/voice-turn.ts`), `MockTtsProvider`; `STT_PROVIDER=mock`. Внимание: без `DEEPGRAM_API_KEY` и без `STT_PROVIDER` сервер молча берёт Whisper и качает модель (providers.ts:23) — в лаборатории ставить mock/inject явно |
| Разовое STT (rescue) | `ISttProvider.transcribeOnce?` | есть только у Deepgram; у Mock/Whisper нет -> подстраховка `skipped`. Фейк: присвоить `stt.transcribeOnce = async()=>"…"` (так сделано в wake-rescue-wiring.test.ts:26) |
| Часы сервера | `VoicePipelineDeps.now`, TurnDetector `now`; таймеры — реальные `setTimeout` (follow-up, silence poll, filler, earcon, quiet, playback-recheck) | `vi.useFakeTimers()` + `now` |
| Агент | `onUserTurn`/`onUserTurnStream` | скрипт-мозг (`MockLlmProvider`, `ScriptedLlm` gateway/bench) или настоящий мозг по подписке |
| Сессия | `Session.send` | заглушка, копящая отправленное (`voiceRig` -> `chunks`) |
| Диктор | `SpeakerGateDeps` | `MockSpeakerVerifier`; по умолчанию гейт выключен |
| Аудио-выход сервера | `sendSpeakChunk` (router-ws.ts:748) | ловить `speak.chunk` |
| Dev-HTTP | `/dev/vad`, `/dev/say` (только `JARVIS_DEV_HTTP=1`, берут ПОСЛЕДНЮЮ ЖИВУЮ клиентскую сессию — server.ts:474-506) | для чисто серверной лаборатории не нужны — лучше свой WS-клиент |
| Модели слуха | `hearingModelsDir()` / `JARVIS_HEARING_MODELS` | на этом ПК стоят в `C:\Users\anton\.jarvis\models` (kws/, silero_vad.onnx — проверено `ls`). Whisper-модель не кэширована (в `hf/` только e5) |

## 4. КАК ПРОВЕРЯТЬ БЕЗ ЧЕЛОВЕКА

### 4.1 Подать записанный WAV через НАСТОЯЩИЙ клиентский код и сервер
Готового такого прогона в репозитории НЕТ (не воспроизводил — собрать в лаборатории). Что есть: `sherpa-hearing.test.ts` (WAV -> голый KWS/VAD без координатора), `_jarvis_voice.mjs` (WAV/TTS -> сервер, БЕЗ клиентского кода: `wake_local` шлёт руками). Рецепт (всё Electron-free):
1. Формат: PCM16 mono 16 кГц, нарезка ровно по 320 сэмплов; в конец 0,6..1,0 с тишины (Silero: `minSilenceDuration` 0,25 с). Корпус — `apps/client/test-audio/{pos,neg}_*.wav` (44-байтовый заголовок, `readWav()` в sherpa-hearing.test.ts:14).
2. Чтобы совпасть с живым трактом, применить к сэмплам ту же кривую, что `micMakeupCurve` (tanh(6x) на float) — иначе KWS/пороги видят другой сигнал (см. дефект D4).
3. Собрать: `createSherpaHearing()` -> `new AudioCoordinator({sendFrame,sendVad,sendRescue,onBargeIn,onMicState,now})` -> `setEngines({wake:h.wake,vad:h.vad})` -> `activate()` (при локальном wake гейт остаётся закрытым, audio/index.ts:215).
4. Подключить: `Transport` (cfg `{host,port,token:"dev-token",clientVersion:"lab-test"}`): `sendFrame->t.sendAudioFrame(pcm,16000,seq++)`, `sendVad->t.sendVad`, `sendRescue->t.sendWakeRescue`; события: `serverState->ac.setServerState`, `wakeRescueResult->ac.onWakeRescued(!!bare)`, `connected->ac.syncServerIdle()` — ровно как main/index.ts:312-347.
5. Кормить `ac.ingest(frame)` в реальном темпе (20 мс/кадр) при реальном сервере (его таймеры реальные). Для ускоренных прогонов — только in-process (`voiceRig` + fake timers), без WS.
6. «Фейковый рендерер»: на каждый `speak.chunk` -> `AudioPlayback(fakePlayerFactory, active=>{ac.setPlaybackActive(active); t.sendPlaybackState(active)}, (gen,ts)=>t.sendAudioPlayed(gen,ts))`. Без этого сервер не получит `audio.playback` (очередь озвучки ждёт оптимистичные 1,5 с) и `audio.played` (метрика mouth-to-ear молчит).
7. Barge-in: подать поверх идущего TTS громкий кадр (rms >= max(250, фон*2.5)) ≥ 200 мс -> `onBargeIn` + `audio.vad barge_in`; порог зависит от `now` -> инжектировать часы.

### 4.2 Забрать озвучку
- Текст: сообщения `transcript{final:true}` (ответ без аудио-тегов) и `chat{role:"assistant"}`; распознанное владельца — `chat{role:"user"}`. ВАЖНО: реально озвученный текст может отличаться (приставка drop-notice «Сэр, один итог я не успел проговорить…» и `[аудио-теги]` идут в TTS, но не в transcript). Точный текст даёт только обёртка над `ITtsProvider`, пишущая `synthesize(text, opts)` (голос/эмоция/скорость) — рекомендую как штатный стенд.
- Аудио: `speak.chunk{audio(base64),seq,last,format?,sampleRate?,gen?}` (router-ws.ts:748). Yandex v1/ElevenLabs — один mp3 на фразу (`last:true`); Yandex v3 (`TTS_PROVIDER=yandex3`) — `format:"pcm16"`, чанки до `last`; earcon/филлер — целый WAV (RIFF) без `format`. Склеивать по `last`; mp3 хранить `.mp3`, pcm16 оборачивать WAV (`wavFromPcm16`, audio.ts:521). Mock TTS отдаёт нули (не звук).
- Тайминги: `gen` = `turnSeq` хода (тег для mouth-to-ear); чанк без `gen` = проактив/фон.

### 4.3 Матрица: чем проверять
| Что | Уровень | Нужно | Уже есть | НЕ покрыто |
|---|---|---|---|---|
| Гейт/preroll/PTT/mute/таймеры | юнит | fake-clock, фейк-движки | `main/audio/index.test.ts` (31), `ptt.test.ts`, `wake-rescue.test.ts` | реальный sherpa внутри координатора; `mic-control.ts`, `gate-closer.ts` только косвенно |
| KWS «Джарвис» | интеграция | audio-replay, модели | `hearing/sherpa-hearing.test.ts` (4; skipIf нет моделей) | голос владельца/комната/AEC; кривая усиления; пропуск ~50% в живую (CHANGELOG:4251) |
| Barge-in (логика) | юнит | fake-clock | `audio/index.test.ts` | акустика (AEC давит double-talk) — liveOnly |
| Рескью клиент+сервер | интеграция | fake-stt.transcribeOnce | `wake-rescue.test.ts` x2 (клиент/сервер), `gateway/wake-rescue-wiring.test.ts` | связка клиентского кода с серверным по настоящему WS |
| Пайплайн (state, wake-гейт, очередь, salvage, m2e) | юнит | fake-clock, fake-stt/tts | `voice/*.test.ts` (~240 кейсов) | настоящий Deepgram-эндпоинтинг (speech_final) — только `deepgram.integration.test.ts` (RUN_LIVE_STT=1) |
| Wiring router-ws аудио | интеграция | voiceRig | `first-answer-wiring`, `task-control-speech`, `speak-result-delivery` | `case "audio.frame"/"audio.vad"/"audio.playback"` через `dispatch` напрямую — не видел теста |
| Плеер | юнит | заглушки Audio/AudioContext | `renderer/audio.test.ts` (24) | реальный `<audio>`/WebAudio, `outputLatency` — liveOnly |
| Транспорт аудио | — | — | тестов нет (`main/transport/` без *.test) | сериализация кадров/vad/played |
| Захват mic | — | hardware | ретрай H18 в `audio.test.ts:289`, `capture-starter.test.ts` | getUserMedia/AEC/ворклет/tanh — liveOnly (идея: Chromium `--use-file-for-fake-audio-capture`, не проверено) |
| Диктор | юнит | модель | `speaker/*.test.ts` | фильтр выключен; на голосе владельца ложно режет |
| Полный голос, настоящий мозг | e2e | real-brain, Deepgram, Yandex | `_jarvis_voice.mjs` (ручной) | автоматического CI-прогона нет |

liveOnly (нужны железо/владелец): захват с реальным микрофоном и AEC, характеристики динамика/задержки, живая акустика barge-in, глобальный хоткей Electron, качество KWS/STT на голосе владельца в его комнате, поведение при занятом устройстве (Dota).

## 5. ДЕФЕКТЫ / ДОЛГ
| # | Сев. | Где | Что |
|---|---|---|---|
| D1 | med | `voice/pipeline.ts` 1795 стр., ~45 приватных полей; `gateWake` :450-589 (140 стр., побочные эффекты: `speakQueued`, `awake`, `lastCmd`) | нарушает закон №3 (SRP); gateWake вызывается 3 путями (спекулятивный, поздний финал, rescue) — хрупко; старый файл, без запроса не трогаю |
| D2 | med | `main/index.ts:312-347` | проводка Transport<->AudioCoordinator<->sherpa зашита в Electron-main и не тестируется; лаборатория вынуждена дублировать -> дрейф. Нужна фабрика `createAudioWiring()` |
| D3 | med | `hearing/sherpa-hearing.test.ts:22` | единственный тест реальных KWS/VAD — отдельно от `AudioCoordinator` и `skipIf(!have)` (тихо пропускается без моделей); связки «Silero speech_start при replay preroll» нет |
| D4 | med | `renderer/audio.ts:20-29` + `integrations/deepgram.ts:130,172,579` | усиление x6 (tanh) на клиенте И `StreamAgc` до x6 на сервере — двойной буст, не измерено; `micMakeupCurve` не экспортирована и зависит от DOM -> корпусные проверки KWS (чистые TTS-WAV) оптимистичнее живого тракта (живьём промах ~50%, CHANGELOG:4251) |
| D5 | med | `voice/pipeline.ts:578-582` | дедуп команды 8 с молча гасит законный повтор («громче», «следующий») — только лог; не проверено живьём |
| D6 | low | `voice/pipeline-rescue.ts:55` | нет `transcribeOnce` (Whisper/mock) или strict-диктор -> `return "skipped"` ДО `onVerdict`: метрика `wake_rescue` не пишется, подстраховка мертва молча |
| D7 | low | `gateway/wake-rescue-route.ts:21` | фрагмент старше 6 с по `env.ts` клиента vs `Date.now()` сервера — для удалённого клиента с дрейфом часов (мобильный пульт) все фрагменты отбрасываются |
| D8 | low | `wakeword/index.ts:34`, `vad/index.ts:160` | `createWakeWord()`, `createVad()` без вызывающих (мёртвый код; каждая создала бы второй экземпляр sherpa); `voice/index.ts:36-49` `IVoiceProcess/VoiceOutEvent/VoiceInCommand` не используются |
| D9 | low | `docs/HOW_IT_WORKS.md:174,178` | устарело: «MockWakeWord (текстовый)» (сейчас sherpa KWS + текстовый гейт) и «persistent WS не сделан» (`deepgram.ts:993` — включён по умолчанию, `JARVIS_DEEPGRAM_PERSISTENT=0` откат); лог `deepgram.ts:999` пишет «=1» |
| D10 | low | `protocol/constants.ts:103` (`FOLLOWUP_WINDOW_MS=6000`), `pipeline.ts:361` (conv 12 с), `router-ws.ts:700-701` (12 с / 8 с), `wake.ts:46` («окно 20с») | четыре разных числа окон; реальные — 12 с и 8 с |
| D11 | low | голосовая область ≈45 разных `JARVIS_*` (grep по области + router-ws/main/deepgram), из них ~15 чистая подстройка порогов (BARGE_*, TURN_*, NOISY_*, PLAYBACK_*) | против закона «один флаг — одно решение» (цель <100 всего) |
| D12 | low | `transport/index.ts:612` | `send()` молча выбрасывает `audio.vad`/`audio.frame` при закрытом сокете, `sendVad` без результата; `speechOpen` в координаторе не сбрасывается в `syncServerIdle` (audio/index.ts:303) — безвредно, но не проверено |
| D13 | low | `voice/wake.ts:9-10` | слой voice импортирует `brain/agent/replay-gate` и `brain/router` (обратная зависимость) |

Высоких (баг, ломающий пользователя) не нашёл; ничего из перечисленного не воспроизводил.

## 6. ТРЕБОВАНИЯ К ЛАБОРАТОРИИ
1. Аудио-стенд: `AudioCoordinator` + настоящий sherpa (`~/.jarvis/models`) + настоящий `Transport` в Node, кормление WAV кадрами по 320 сэмплов с воспроизведением `micMakeupCurve`; управляемые часы (или реальный темп).
2. Фейковый рендерер: `AudioPlayback` с фейк-плеером + подтверждения `audio.playback`/`audio.played` (иначе очередь речи и метрики врут).
3. Запись озвучки: обёртка `ITtsProvider` (точный текст+опции) и приём `speak.chunk` в файлы (mp3/pcm16->WAV); текст из `transcript`/`chat`.
4. Явный выбор STT: mock/скриптовый/настоящий Deepgram; нельзя допускать молчаливый откат на Whisper. Фейковый `transcribeOnce` для подстраховки.
5. Тайминговый режим: ускоренный in-process (`voiceRig` + fake timers) и реальный (WS) — с явной пометкой, какие таймеры реальные.
6. Корпус: расширить `test-audio/` (владельческие голоса недоступны -> TTS filipp/zahar/jane/alena, шум/ТВ-фон, «Джарвис» с паузой и без, near-miss «Дарья/Джаз») и метрика попаданий KWS по нему; отчёт «доля rescue».
7. Проверка контрактов: тест `dispatch` для `audio.frame/vad/played/playback` и `Transport.sendAudio*` (сейчас нет).
8. Отдельная пометка liveOnly-сценариев (mic/AEC/динамик/хоткей) — их закрывает только владелец или Chromium с fake-media-stream (гипотеза).
