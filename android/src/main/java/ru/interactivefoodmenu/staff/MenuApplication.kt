package ru.interactivefoodmenu.staff

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.storage.FirebaseStorage
import ru.interactivefoodmenu.staff.data.MenuRepository
import ru.interactivefoodmenu.staff.data.VenuePreferences

class MenuApplication : Application() {
    var repository: MenuRepository? = null
        private set
    lateinit var preferences: VenuePreferences
        private set

    override fun onCreate() {
        super.onCreate()
        preferences = VenuePreferences(this)
        if (!BuildConfig.HAS_FIREBASE_CONFIG || FirebaseApp.initializeApp(this) == null) return

        // Emulator requests do not need App Check. Skipping the provider also
        // keeps local development working when the emulator has no Internet
        // access to firebaseappcheck.googleapis.com.
        if (!BuildConfig.USE_FIREBASE_EMULATORS) {
            FirebaseAppCheck.getInstance().installAppCheckProviderFactory(
                if (BuildConfig.DEBUG) DebugAppCheckProviderFactory.getInstance()
                else PlayIntegrityAppCheckProviderFactory.getInstance(),
            )
        }
        val auth = FirebaseAuth.getInstance()
        val firestore = FirebaseFirestore.getInstance()
        val functions = FirebaseFunctions.getInstance(BuildConfig.FUNCTIONS_REGION)
        val storage = FirebaseStorage.getInstance()
        if (BuildConfig.USE_FIREBASE_EMULATORS) {
            auth.useEmulator(BuildConfig.FIREBASE_EMULATOR_HOST, 9099)
            firestore.useEmulator(BuildConfig.FIREBASE_EMULATOR_HOST, 8080)
            functions.useEmulator(BuildConfig.FIREBASE_EMULATOR_HOST, 5001)
            storage.useEmulator(BuildConfig.FIREBASE_EMULATOR_HOST, 9199)
        }
        repository = MenuRepository(
            auth,
            firestore,
            functions,
            storage,
            BuildConfig.DISPLAY_BASE_URL.takeIf { it.isNotBlank() },
        )
    }
}
