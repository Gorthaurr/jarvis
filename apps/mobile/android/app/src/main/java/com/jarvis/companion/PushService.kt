package com.jarvis.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * §9: PushService — приём FCM data-сообщений от сервера Jarvis.
 *
 * Используем data-сообщения (не notification), чтобы:
 * 1. Валидировать expiresAt ДО показа нотификации (§9 — просроченный nudge молча отбрасывается).
 * 2. Иметь полный контроль над содержимым и временем показа.
 *
 * Сервер отправляет payload соответствующий ProactiveNudge из @jarvis/protocol:
 *   { type: "proactive.nudge", text, reason, expiresAt }
 */
class PushService : FirebaseMessagingService() {

    private val tag = "PushService"
    private val scope = CoroutineScope(Dispatchers.IO)

    // ─── FCM lifecycle ────────────────────────────────────────────────────────

    /**
     * Вызывается при обновлении FCM-токена устройства.
     * Новый токен нужно зарегистрировать на сервере (§13: таблица devices).
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(tag, "Получен новый FCM-токен")
        // Регистрируем токен на сервере в IO-корутине
        scope.launch {
            registerTokenWithServer(token)
        }
    }

    /**
     * Вызывается при получении входящего FCM data-сообщения.
     * Метод выполняется максимум 20 секунд (ограничение FCM).
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        val data = message.data
        if (data.isEmpty()) {
            Log.w(tag, "Получено FCM-сообщение без data-payload — игнорируем")
            return
        }

        val messageType = data["type"] ?: run {
            Log.w(tag, "FCM data без поля 'type' — игнорируем")
            return
        }

        Log.d(tag, "FCM data-сообщение: type=$messageType")

        when (messageType) {
            "proactive.nudge" -> handleProactiveNudge(data)
            "task.status"     -> handleTaskStatus(data)
            else              -> Log.d(tag, "Неизвестный тип FCM-сообщения: $messageType")
        }
    }

    // ─── Обработчики типов сообщений ─────────────────────────────────────────

    /**
     * §9: обработка ProactiveNudge.
     *
     * Алгоритм:
     * 1. Разобрать payload.
     * 2. Проверить expiresAt — если просрочен, отбросить без показа (§9).
     * 3. Показать нотификацию с text и reason.
     */
    private fun handleProactiveNudge(data: Map<String, String>) {
        val text = data["text"] ?: run {
            Log.w(tag, "nudge без поля 'text' — игнорируем")
            return
        }
        val reason = data["reason"] ?: ""
        val expiresAtStr = data["expiresAt"]
        val expiresAt = expiresAtStr?.toLongOrNull()

        // §9: валидация expiresAt на устройстве — просроченный nudge не показываем
        if (expiresAt != null && System.currentTimeMillis() > expiresAt) {
            val overdueSec = (System.currentTimeMillis() - expiresAt) / 1000
            Log.i(tag, "nudge просрочен на ${overdueSec}с — отбрасываем (§9)")
            return
        }

        Log.i(tag, "Показываем nudge: text=${text.take(60)}, reason=$reason")
        showNudgeNotification(text = text, reason = reason)
    }

    /**
     * §17: обработка task.status (обновление статуса задачи пользователю).
     * TODO(M4): показать прогресс-нотификацию или обновить UI активности.
     */
    private fun handleTaskStatus(data: Map<String, String>) {
        val taskId = data["taskId"] ?: return
        val state = data["state"] ?: return
        val summary = data["summary"] ?: ""
        Log.d(tag, "task.status: taskId=$taskId, state=$state, summary=${summary.take(60)}")
        // TODO(M4): обновить нотификацию / уведомить активность через LocalBroadcast
    }

    // ─── Нотификации ─────────────────────────────────────────────────────────

    /**
     * Показывает нотификацию с текстом nudge.
     * Канал создаётся один раз (безопасно вызывать повторно).
     */
    private fun showNudgeNotification(text: String, reason: String) {
        ensureNotificationChannel()

        // Тап по нотификации открывает главный экран
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_NUDGE_TEXT, text)
        }
        val pendingTapIntent = PendingIntent.getActivity(
            this,
            NUDGE_NOTIFICATION_ID,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID_NUDGE)
            .setSmallIcon(android.R.drawable.ic_dialog_info) // TODO(M2): заменить на кастомную иконку
            .setContentTitle("Jarvis")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingTapIntent)

        if (reason.isNotBlank()) {
            builder.setSubText(reason)
        }

        // TODO(M2): проверить POST_NOTIFICATIONS разрешение перед show() на API 33+
        NotificationManagerCompat.from(this).notify(NUDGE_NOTIFICATION_ID, builder.build())
    }

    /**
     * Создаёт NotificationChannel для nudge-уведомлений (требуется API 26+).
     * Повторный вызов — no-op.
     */
    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID_NUDGE) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID_NUDGE,
            "Напоминания Jarvis",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Проактивные напоминания и подсказки от Jarvis (§9)"
            enableVibration(true)
        }
        manager.createNotificationChannel(channel)
    }

    // ─── Регистрация токена ───────────────────────────────────────────────────

    /**
     * Регистрирует FCM-токен на сервере.
     * Сервер сохраняет токен в таблице devices (§13) для последующей отправки пушей.
     */
    private suspend fun registerTokenWithServer(token: String) {
        // TODO(M3): получить ApiClient через DI
        val apiClient = ApiClient(applicationContext)
        val success = apiClient.registerDevice(
            pushToken = token,
            platform = "android",
        )
        if (success) {
            Log.i(tag, "FCM-токен успешно зарегистрирован на сервере")
        } else {
            Log.e(tag, "Не удалось зарегистрировать FCM-токен — повтор при следующем запуске")
            // TODO(M3): сохранить флаг в SharedPreferences, повторить при старте
        }
    }

    companion object {
        const val CHANNEL_ID_NUDGE = "jarvis_nudge"
        const val NUDGE_NOTIFICATION_ID = 1001
        const val EXTRA_NUDGE_TEXT = "nudge_text"
    }
}
