package com.jarvis.companion

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * ApiClient — HTTPS-клиент для взаимодействия с сервером Jarvis.
 *
 * Покрывает два основных сценария:
 * 1. §12, §13: регистрация устройства + push-токена в таблице devices.
 * 2. §9, §12: отправка гео-события (смена локации) для presence-роутинга.
 *
 * Намеренно без сторонних зависимостей (HttpURLConnection) — минимальный APK.
 * TODO(M3): заменить на OkHttp / Ktor-client если понадобится connection pooling, TLS pinning.
 */
class ApiClient(context: Context) {

    private val tag = "ApiClient"
    private val prefs = context.getSharedPreferences("jarvis_prefs", Context.MODE_PRIVATE)

    /**
     * Базовый URL сервера Jarvis.
     * В production — из BuildConfig.SERVER_URL (задаётся в app/build.gradle.kts).
     * TODO(M2): инжектировать через BuildConfig вместо хардкода.
     */
    private val serverUrl: String
        get() = prefs.getString("server_url", BuildConfigStub.SERVER_URL) ?: BuildConfigStub.SERVER_URL

    /**
     * API-ключ устройства (выдаётся сервером при первой регистрации).
     * Хранится в SharedPreferences.
     */
    private val apiKey: String?
        get() = prefs.getString("api_key", null)

    /**
     * Уникальный ID этого устройства (генерируется один раз при установке).
     */
    private val deviceId: String
        get() {
            return prefs.getString("device_id", null) ?: run {
                val id = UUID.randomUUID().toString()
                prefs.edit().putString("device_id", id).apply()
                id
            }
        }

    // ─── Регистрация устройства (§13) ────────────────────────────────────────

    /**
     * Регистрирует устройство и push-токен на сервере.
     * Сервер сохраняет запись в таблице devices (§13):
     *   { deviceId, pushToken, platform, lastSeen, lastLocation? }
     *
     * Возвращает true при успехе (HTTP 200/201).
     */
    suspend fun registerDevice(
        pushToken: String,
        platform: String,
    ): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("deviceId", deviceId)
            put("pushToken", pushToken)
            put("platform", platform)
        }

        try {
            val response = post(path = "/api/devices", body = body)
            if (response.statusCode in 200..299) {
                // Если сервер вернул api_key — сохраняем
                response.body?.optString("apiKey")?.takeIf { it.isNotBlank() }?.let { key ->
                    prefs.edit().putString("api_key", key).apply()
                    Log.i(tag, "API-ключ сохранён")
                }
                Log.i(tag, "Устройство зарегистрировано: deviceId=$deviceId")
                true
            } else {
                Log.w(tag, "registerDevice: HTTP ${response.statusCode}")
                false
            }
        } catch (e: IOException) {
            Log.e(tag, "registerDevice: сетевая ошибка: ${e.message}", e)
            false
        }
    }

    // ─── Гео-событие (§9, §12) ───────────────────────────────────────────────

    /**
     * Отправляет гео-событие на сервер.
     * Сервер обновит device.lastLocation и применит presence-роутинг (§9):
     * выбор канала уведомлений, детализации ответов, умных напоминаний.
     *
     * @param placeId     ID места из §13 ("home" | "work" | "gym" | "custom_<uuid>")
     * @param transition  тип перехода ("enter" | "exit" | "dwell")
     * @param timestampMs Unix-время события в миллисекундах
     */
    suspend fun sendGeoEvent(
        placeId: String,
        transition: String,
        timestampMs: Long,
    ): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("deviceId", deviceId)
            put("placeId", placeId)
            put("transition", transition)
            put("timestampMs", timestampMs)
        }

        try {
            val response = post(path = "/api/geo/event", body = body)
            val ok = response.statusCode in 200..299
            if (!ok) {
                Log.w(tag, "sendGeoEvent: HTTP ${response.statusCode} для placeId=$placeId")
            }
            ok
        } catch (e: IOException) {
            Log.e(tag, "sendGeoEvent: сетевая ошибка: ${e.message}", e)
            false
        }
    }

    // ─── Низкоуровневые HTTP-утилиты ─────────────────────────────────────────

    private data class HttpResponse(
        val statusCode: Int,
        val body: JSONObject?,
    )

    /**
     * Выполняет HTTP POST с JSON-телом.
     * Всегда добавляет заголовки Authorization и X-Device-Id.
     */
    private fun post(path: String, body: JSONObject): HttpResponse {
        val url = URL("$serverUrl$path")
        val connection = url.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-Device-Id", deviceId)
            apiKey?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            connection.doOutput = true
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS

            val bodyBytes = body.toString().toByteArray(Charsets.UTF_8)
            connection.outputStream.use { it.write(bodyBytes) }

            val statusCode = connection.responseCode
            val responseBody = runCatching {
                val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
                JSONObject(stream.bufferedReader().readText())
            }.getOrNull()

            HttpResponse(statusCode = statusCode, body = responseBody)
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 15_000
    }
}

/**
 * Заглушка BuildConfig для компиляции без Android Gradle Plugin.
 * В реальной сборке эти значения генерируются из app/build.gradle.kts.
 * TODO(M2): удалить после настройки Gradle build.
 */
private object BuildConfigStub {
    const val SERVER_URL: String = "https://jarvis.example.com"
}
