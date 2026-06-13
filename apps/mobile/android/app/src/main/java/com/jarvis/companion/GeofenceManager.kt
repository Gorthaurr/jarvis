package com.jarvis.companion

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * §12, §13: места пользователя (home / work / gym + кастомные).
 * Хранятся локально и синхронизируются с сервером.
 */
data class Place(
    val id: String,           // "home" | "work" | "gym" | "custom_<uuid>"
    val label: String,        // человекочитаемое название
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Float,  // home=100м, work/gym=150м по умолчанию
)

/**
 * §12: тип перехода через границу геофенса.
 */
enum class GeoTransition(val gmsValue: Int) {
    ENTER(Geofence.GEOFENCE_TRANSITION_ENTER),
    EXIT(Geofence.GEOFENCE_TRANSITION_EXIT),
    DWELL(Geofence.GEOFENCE_TRANSITION_DWELL),
}

/**
 * GeofenceManager — регистрирует геофенсы вокруг мест пользователя (§12, §13).
 *
 * Используем Geofencing API из Google Play Services (НЕ поллинг GPS):
 * Android сам детектирует переходы через комбинацию вышек сотовой связи + Wi-Fi,
 * что обеспечивает минимальный расход батареи (§9).
 *
 * При срабатывании GeofenceBroadcastReceiver отправляет событие на сервер
 * через ApiClient, чтобы сервер мог обновить presence-роутинг (§9).
 */
class GeofenceManager(private val context: Context) {

    private val tag = "GeofenceManager"

    // GMS-клиент — единственная точка входа к Geofencing API
    private val geofencingClient: GeofencingClient by lazy {
        LocationServices.getGeofencingClient(context)
    }

    /**
     * PendingIntent, который GMS вызывает при срабатывании геофенса.
     * Указывает на GeofenceBroadcastReceiver.
     */
    private val geofencePendingIntent: PendingIntent by lazy {
        val intent = Intent(context, GeofenceBroadcastReceiver::class.java).apply {
            action = "com.jarvis.companion.ACTION_GEOFENCE_EVENT"
        }
        PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
    }

    /**
     * Регистрирует геофенсы для переданного списка мест.
     * Вызывается при старте приложения и при изменении списка мест (§13).
     *
     * Требует разрешений ACCESS_FINE_LOCATION + ACCESS_BACKGROUND_LOCATION.
     */
    fun registerFences(places: List<Place>) {
        if (!hasRequiredPermissions()) {
            Log.w(tag, "Нет разрешений для геофенсинга — пропускаем регистрацию")
            // TODO(M2): запросить разрешения через UI, если активность доступна
            return
        }

        if (places.isEmpty()) {
            Log.d(tag, "Список мест пуст — геофенсы не регистрируем")
            return
        }

        val geofences = places.map { place -> buildGeofence(place) }
        val request = GeofencingRequest.Builder()
            .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
            .addGeofences(geofences)
            .build()

        // TODO(M2): обработать SecurityException если разрешения отозваны в процессе
        geofencingClient.addGeofences(request, geofencePendingIntent)
            .addOnSuccessListener {
                Log.i(tag, "Зарегистрировано геофенсов: ${places.size}")
            }
            .addOnFailureListener { e ->
                Log.e(tag, "Ошибка регистрации геофенсов: ${e.message}", e)
            }
    }

    /**
     * Снимает все активные геофенсы (например, при разлогине пользователя).
     */
    fun removeAllFences() {
        geofencingClient.removeGeofences(geofencePendingIntent)
            .addOnSuccessListener { Log.i(tag, "Геофенсы сняты") }
            .addOnFailureListener { e -> Log.e(tag, "Ошибка снятия геофенсов: ${e.message}", e) }
    }

    private fun buildGeofence(place: Place): Geofence =
        Geofence.Builder()
            .setRequestId(place.id)
            .setCircularRegion(place.latitude, place.longitude, place.radiusMeters)
            .setTransitionTypes(
                Geofence.GEOFENCE_TRANSITION_ENTER or
                    Geofence.GEOFENCE_TRANSITION_EXIT or
                    Geofence.GEOFENCE_TRANSITION_DWELL,
            )
            // NEVER_EXPIRE — фенсы живут пока не снимем явно
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            // Задержка перед DWELL чтобы не спамить при проезде мимо (§9)
            .setLoiteringDelay(DWELL_DELAY_MS)
            .build()

    private fun hasRequiredPermissions(): Boolean {
        val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
        val background = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        return fine == PackageManager.PERMISSION_GRANTED && background == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        /** Задержка перед событием DWELL (5 минут) — отсекает случайные остановки. */
        private const val DWELL_DELAY_MS = 5 * 60 * 1000

        /** Дефолтный радиус для home-геофенса в метрах. */
        const val DEFAULT_RADIUS_HOME_M = 100f

        /** Дефолтный радиус для work/gym-геофенсов в метрах. */
        const val DEFAULT_RADIUS_WORK_M = 150f
    }
}

// ─── BroadcastReceiver ────────────────────────────────────────────────────────

/**
 * §12: принимает события от Geofencing API и отправляет их на сервер Jarvis.
 *
 * Геофенс-событие = смена контекста пользователя → сервер может применить
 * presence-роутинг (§9): выбрать канал уведомлений, детализацию ответов и т.д.
 */
class GeofenceBroadcastReceiver : BroadcastReceiver() {

    private val tag = "GeofenceBroadcastReceiver"

    // Scope для корутин (Dispatchers.IO — сетевой запрос)
    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return

        if (event.hasError()) {
            val errorMessage = GeofenceStatusCodes.getStatusCodeString(event.errorCode)
            Log.e(tag, "Ошибка геофенса: $errorMessage")
            return
        }

        val transition = event.geofenceTransition
        val triggeringFences = event.triggeringGeofences ?: emptyList()

        if (triggeringFences.isEmpty()) {
            Log.w(tag, "Нет активных геофенсов в событии")
            return
        }

        val transitionType = when (transition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> GeoTransition.ENTER
            Geofence.GEOFENCE_TRANSITION_EXIT -> GeoTransition.EXIT
            Geofence.GEOFENCE_TRANSITION_DWELL -> GeoTransition.DWELL
            else -> {
                Log.w(tag, "Неизвестный тип перехода: $transition")
                return
            }
        }

        for (fence in triggeringFences) {
            Log.i(tag, "Геофенс '${fence.requestId}': $transitionType")
            // Отправляем гео-событие на сервер в IO-корутине
            scope.launch {
                sendGeoEventToServer(context, placeId = fence.requestId, transition = transitionType)
            }
        }
    }

    /**
     * Отправляет гео-событие на сервер через ApiClient.
     * Сервер обновит device.lastLocation и применит presence-роутинг (§9, §13).
     */
    private suspend fun sendGeoEventToServer(
        context: Context,
        placeId: String,
        transition: GeoTransition,
    ) {
        // TODO(M3): получить ApiClient через DI (Hilt / manual singleton)
        val apiClient = ApiClient(context)
        val result = apiClient.sendGeoEvent(
            placeId = placeId,
            transition = transition.name.lowercase(),
            timestampMs = System.currentTimeMillis(),
        )
        if (!result) {
            Log.e(tag, "Не удалось отправить гео-событие для '$placeId'")
            // TODO(M3): поставить в очередь для повтора (WorkManager)
        }
    }
}
