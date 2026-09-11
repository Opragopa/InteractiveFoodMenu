package ru.interactivefoodmenu.staff

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class ConfigurationScreenTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test fun missingFirebaseConfigurationIsExplained() {
        if (!BuildConfig.HAS_FIREBASE_CONFIG) {
            rule.onNodeWithText("Firebase не настроен").assertIsDisplayed()
            rule.onNodeWithText("Добавьте android/google-services.json и пересоберите приложение.").assertIsDisplayed()
        }
    }
}
