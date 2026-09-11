import java.util.Properties

val googleServicesFile = file("google-services.json")
val firebasePackageNames = if (googleServicesFile.exists()) {
    Regex(""""package_name"\s*:\s*"([^"]+)"""")
        .findAll(googleServicesFile.readText())
        .map { it.groupValues[1] }
        .toSet()
} else {
    emptySet()
}
val firebaseApplicationId = firebasePackageNames.firstOrNull() ?: "ru.interactivefoodmenu.staff"
val debugApplicationId = "$firebaseApplicationId.debug"
val useFirebaseEmulatorsOverride = providers.gradleProperty("useFirebaseEmulators").orNull?.toBooleanStrictOrNull()
val firebaseEmulatorHost = providers.gradleProperty("firebaseEmulatorHost").orNull ?: "127.0.0.1"
val displayBaseUrlOverride = providers.gradleProperty("displayBaseUrl").orNull?.trim()?.removeSuffix("/")
val debugUsesEmulators = useFirebaseEmulatorsOverride ?: true
val debugDisplayBaseUrl = displayBaseUrlOverride ?: if (debugUsesEmulators && firebaseEmulatorHost !in setOf("localhost", "127.0.0.1", "::1")) {
    "http://$firebaseEmulatorHost:5173"
} else {
    ""
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

if (googleServicesFile.exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "ru.interactivefoodmenu.staff"
    compileSdk = 37

    defaultConfig {
        applicationId = firebaseApplicationId
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("boolean", "HAS_FIREBASE_CONFIG", googleServicesFile.exists().toString())
        buildConfigField("boolean", "USE_FIREBASE_EMULATORS", "false")
        buildConfigField("String", "FIREBASE_EMULATOR_HOST", "\"$firebaseEmulatorHost\"")
        buildConfigField("String", "DISPLAY_BASE_URL", "\"\"")
        buildConfigField("String", "FUNCTIONS_REGION", "\"europe-west1\"")
    }

    signingConfigs {
        val propertiesFile = rootProject.file("android/keystore.properties")
        if (propertiesFile.exists()) {
            create("release") {
                val properties = Properties().apply { propertiesFile.inputStream().use(::load) }
                storeFile = file(properties.getProperty("storeFile"))
                storePassword = properties.getProperty("storePassword")
                keyAlias = properties.getProperty("keyAlias")
                keyPassword = properties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            if (!googleServicesFile.exists() || debugApplicationId in firebasePackageNames) {
                applicationIdSuffix = ".debug"
            }
            buildConfigField("boolean", "USE_FIREBASE_EMULATORS", (useFirebaseEmulatorsOverride ?: true).toString())
            buildConfigField("String", "FIREBASE_EMULATOR_HOST", "\"$firebaseEmulatorHost\"")
            buildConfigField("String", "DISPLAY_BASE_URL", "\"$debugDisplayBaseUrl\"")
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signingConfigs.names.contains("release")) signingConfig = signingConfigs.getByName("release")
            buildConfigField("boolean", "USE_FIREBASE_EMULATORS", "false")
            buildConfigField("String", "FIREBASE_EMULATOR_HOST", "\"$firebaseEmulatorHost\"")
            buildConfigField("String", "DISPLAY_BASE_URL", "\"${displayBaseUrlOverride ?: ""}\"")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.08.00"))
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.08.00"))
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.11.0")
    implementation("com.google.zxing:core:3.5.4")
    implementation("com.google.mlkit:text-recognition:16.0.1")

    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-firestore")
    implementation("com.google.firebase:firebase-functions")
    implementation("com.google.firebase:firebase-storage")
    implementation("com.google.firebase:firebase-appcheck-playintegrity")
    implementation("com.google.firebase:firebase-appcheck-debug")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
