/*
 * app/build.gradle.kts — модуль Android-приложения Jarvis Companion
 *
 * Зависимости (§12):
 *   - play-services-location  → Geofencing API (без поллинга GPS, §9)
 *   - firebase-messaging      → FCM data-сообщения (proactive.nudge, §9)
 *
 * Версии указаны как PLACEHOLDER — замени на актуальные перед сборкой.
 * Актуальные версии: https://developers.google.com/android/guides/setup
 */

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // FCM: подключи google-services плагин (скачай google-services.json в app/)
    id("com.google.gms.google-services")
}

android {
    namespace = "com.jarvis.companion"
    compileSdk = 35  // TODO(M2): обновить до актуального

    defaultConfig {
        applicationId = "com.jarvis.companion"
        minSdk = 26          // Android 8 — минимум для NotificationChannel
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // §9, §12: URL сервера и API-ключ как BuildConfig-поля.
        // Заполни в local.properties или через CI-переменные.
        buildConfigField("String", "SERVER_URL",
            "\"${project.findProperty("JARVIS_SERVER_URL") ?: "https://jarvis.example.com"}\"")
        buildConfigField("String", "API_KEY",
            "\"${project.findProperty("JARVIS_API_KEY") ?: ""}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // TODO(M2): добавить TLS pinning через network_security_config.xml
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // ─── Kotlin / Coroutines ──────────────────────────────────────────────
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.0.0")             // PLACEHOLDER
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")  // PLACEHOLDER

    // ─── AndroidX core ───────────────────────────────────────────────────
    implementation("androidx.core:core-ktx:1.13.0")                        // PLACEHOLDER
    implementation("androidx.appcompat:appcompat:1.7.0")                   // PLACEHOLDER

    // ─── Google Play Services: Geofencing API (§12) ───────────────────
    //     Ключевая зависимость: Geofencing без поллинга GPS (§9).
    //     Документация: https://developers.google.com/location-context/geofencing
    implementation("com.google.android.gms:play-services-location:21.3.0") // PLACEHOLDER

    // ─── Firebase: FCM data-сообщения (§9) ───────────────────────────
    //     BOM управляет версиями всех firebase-* артефактов.
    //     Документация: https://firebase.google.com/docs/android/setup
    implementation(platform("com.google.firebase:firebase-bom:33.1.0"))    // PLACEHOLDER
    implementation("com.google.firebase:firebase-messaging-ktx")

    // ─── Нотификации ─────────────────────────────────────────────────
    implementation("androidx.core:core-ktx:1.13.0")                        // PLACEHOLDER (уже выше)

    // ─── Тесты ───────────────────────────────────────────────────────
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")

    // TODO(M3): добавить Hilt для DI (ApiClient, GeofenceManager)
    // implementation("com.google.dagger:hilt-android:2.51.1")
    // kapt("com.google.dagger:hilt-compiler:2.51.1")

    // TODO(M3): OkHttp для TLS pinning и connection pooling
    // implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
