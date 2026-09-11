package ru.interactivefoodmenu.staff.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.first
import java.util.UUID

private val Context.dataStore by preferencesDataStore("venue_preferences")

class VenuePreferences(private val context: Context) {
    private val venueCodeKey = stringPreferencesKey("venue_code")
    private val installationIdKey = stringPreferencesKey("installation_id")
    val venueCode: Flow<String> = context.dataStore.data.map { it[venueCodeKey].orEmpty() }
    suspend fun saveVenueCode(code: String) = context.dataStore.edit { it[venueCodeKey] = code }
    suspend fun installationId(): String {
        val existing = context.dataStore.data.first()[installationIdKey]
        if (existing != null) return existing
        val created = UUID.randomUUID().toString()
        context.dataStore.edit { it[installationIdKey] = created }
        return created
    }
    suspend fun clear() = context.dataStore.edit { it.clear() }
}
