/*
 * build.gradle.kts — корневой Gradle проекта Jarvis Companion (Android)
 *
 * Подключает Android Gradle Plugin (AGP) и Kotlin-плагин.
 * google-services плагин нужен для firebase-messaging (FCM, §9).
 *
 * Актуальные версии AGP: https://developer.android.com/build/releases/gradle-plugin
 */

plugins {
    id("com.android.application")          version "8.4.0" apply false  // PLACEHOLDER
    id("com.android.library")             version "8.4.0" apply false  // PLACEHOLDER
    id("org.jetbrains.kotlin.android")    version "2.0.0" apply false  // PLACEHOLDER
    // FCM / google-services (§9)
    id("com.google.gms.google-services")  version "4.4.2" apply false  // PLACEHOLDER
}

// Общая конфигурация для всех подпроектов
allprojects {
    repositories {
        google()        // AGP, GMS, Firebase
        mavenCentral()  // Kotlin, OkHttp, etc.
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
