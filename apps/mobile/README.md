# @jarvis/mobile — Android-first компаньон

## Назначение (§0, §12)

Мобильный компаньон решает две задачи:

1. **Геофенсинг** — уведомлять сервер о смене локации пользователя (home / work / gym и кастомные места из §13),
   чтобы сервер мог выбирать нужный сценарий (presence-роутинг) без постоянного опроса GPS.
2. **Push-уведомления (FCM)** — принимать `proactive.nudge` и другие data-сообщения от сервера,
   валидировать `expiresAt` на устройстве и показывать нотификацию только если она ещё актуальна (§9).

Голосовой ввод в реальном времени (ambient voice) — **не** задача этого модуля; это функция desktop-клиента (§0).
iOS — отдельная цель: те же push + geo API, плюс foreground-голос (§0); структура повторяет Android.

---

## Архитектура

```
┌────────────────────────────────────────────────────┐
│                   Android App                      │
│                                                    │
│  ┌─────────────────┐   ┌────────────────────────┐ │
│  │ GeofenceManager │   │  PushService (FCM)     │ │
│  │                 │   │                        │ │
│  │ registerFences()│   │ onMessageReceived()    │ │
│  │  → Geofencing   │   │  → валидация expiresAt │ │
│  │    API (GMS)    │   │  → showNotification()  │ │
│  └────────┬────────┘   └────────────────────────┘ │
│           │ геофенс-событие                        │
│           ▼                                        │
│  ┌─────────────────┐                               │
│  │   ApiClient     │────► HTTPS ──► /api/geo/event │
│  │                 │────► HTTPS ──► /api/devices    │
│  └─────────────────┘       (регистрация push_token) │
└────────────────────────────────────────────────────┘
```

### Геофенсинг (§9, §12)

- Используем **Geofencing API** из Google Play Services (пакет `play-services-location`).
- Не поллим GPS — Android сам детектирует вход/выход из фенса через вышки и Wi-Fi, расход батареи минимален (§9).
- Фенсы регистрируются при старте и при изменении списка мест (home / work / gym / custom) из §13.
- Радиус по умолчанию: `home` = 100 м, `work`/`gym` = 150 м.
- При срабатывании `GeofenceBroadcastReceiver` вызывает `ApiClient.sendGeoEvent(placeId, transition)` по HTTPS.
- Сервер получает событие, обновляет `device.lastSeen` / `device.location` и может менять presence-роутинг
  (например, на работе — короткие текстовые ответы, дома — полный голос).

### Push-уведомления (FCM, §9)

- Используем **FCM data-сообщения** (не notification-сообщения) — это даёт полный контроль над показом.
- `PushService extends FirebaseMessagingService` получает `RemoteMessage`.
- Поле `data["expiresAt"]` (Unix-timestamp в мс) проверяется **до** показа нотификации.
  Просроченный nudge молча отбрасывается (§9: умные напоминания только когда актуальны).
- Push-token регистрируется на сервере при первом запуске и при обновлении токена через `ApiClient.registerDevice()`.
- Payload соответствует `ProactiveNudge` из `@jarvis/protocol`: `{text, reason, expiresAt}`.

### Presence-роутинг (§9)

Сервер хранит таблицу `devices` (§13): `{deviceId, pushToken, platform, lastLocation, lastSeen}`.
Мобильный компаньон пишет в эту таблицу через `/api/devices` и `/api/geo/event`.
На основе `lastLocation` сервер решает, какой канал уведомлений использовать и с какой детализацией.

---

## Разрешения Android

| Разрешение | Зачем |
|---|---|
| `ACCESS_FINE_LOCATION` | Геофенсинг требует точной геолокации |
| `ACCESS_BACKGROUND_LOCATION` | Детектировать вход/выход из фенса когда приложение в фоне |
| `INTERNET` | HTTPS-запросы к серверу |
| `POST_NOTIFICATIONS` | Показывать push-нотификации (Android 13+) |
| `RECEIVE_BOOT_COMPLETED` | Восстанавливать фенсы после перезагрузки |

> **Play Store**: `ACCESS_BACKGROUND_LOCATION` требует дополнительного обоснования в политике конфиденциальности
> и проверки Google (§18). Для sideload-сборок ограничений нет.

---

## Сборка

Проект — нативный Android (Kotlin + Gradle). Не входит в pnpm workspace (нет Node-зависимостей).

```bash
cd apps/mobile/android
./gradlew assembleDebug
```

Требования: Android Studio Hedgehog+, JDK 17+, Google Services JSON (`google-services.json`) в `app/`.

### Переменные окружения (дублируют `.env.example` из корня)

```
JARVIS_SERVER_URL=https://your-server.example.com
JARVIS_API_KEY=<токен устройства, выдаётся сервером>
```

В Android — через `BuildConfig` (задаются в `app/build.gradle.kts`).

---

## Структура файлов

```
apps/mobile/
  README.md
  android/
    build.gradle.kts          # корневой Gradle
    app/
      build.gradle.kts        # зависимости приложения
      src/main/
        AndroidManifest.xml
        java/com/jarvis/companion/
          GeofenceManager.kt  # регистрация фенсов + BroadcastReceiver
          PushService.kt      # FCM-сервис + валидация expiresAt
          ApiClient.kt        # HTTPS-клиент к серверу
```
