package ru.interactivefoodmenu.staff.data

import android.net.Uri
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.storage.FirebaseStorage
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import ru.interactivefoodmenu.staff.model.MenuCategory
import ru.interactivefoodmenu.staff.model.MenuItem
import ru.interactivefoodmenu.staff.model.MenuSnapshot
import ru.interactivefoodmenu.staff.model.Venue
import ru.interactivefoodmenu.staff.model.CsvMenuRow

class MenuRepository(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val functions: FirebaseFunctions,
    private val storage: FirebaseStorage,
    private val displayBaseUrl: String? = null,
) {
    suspend fun restoredVenueId(): String? {
        val user = auth.currentUser ?: return null
        return user.getIdToken(false).await().claims["venueId"] as? String
    }

    suspend fun login(venueCode: String, pin: String, installationId: String): String {
        // A locally cached custom-token session may have an invalid refresh
        // token after the emulator was reset or the staff version was rotated.
        // Clear it before starting a fresh PIN login so Auth does not race the
        // callable request with a failed token refresh.
        auth.signOut()
        Log.i("MenuRepository", "Calling loginStaff via Firebase Functions emulator")
        val result = try {
            functions.getHttpsCallable("loginStaff").call(
                mapOf("venueCode" to venueCode.trim().lowercase(), "pin" to pin, "installationId" to installationId),
            ).await().data as Map<*, *>
        } catch (error: Exception) {
            val details = if (error is FirebaseFunctionsException) {
                "code=${error.code}, details=${error.details}, message=${error.message}"
            } else {
                "type=${error::class.java.name}, message=${error.message}"
            }
            Log.e("MenuRepository", "loginStaff failed: $details", error)
            throw error
        }
        Log.i("MenuRepository", "loginStaff callable returned successfully")
        val customToken = result["customToken"] as String
        val venueId = result["venueId"] as String
        auth.signInWithCustomToken(customToken).await()
        return venueId
    }

    fun observeMenu(venueId: String): Flow<MenuSnapshot> = callbackFlow {
        var venue: Venue? = null
        var categories = emptyList<MenuCategory>()
        var items = emptyList<MenuItem>()
        var venuePending = false
        var categoriesPending = false
        var itemsPending = false
        var venueCached = false
        var categoriesCached = false
        var itemsCached = false
        fun emit() = trySend(MenuSnapshot(
            venue, categories, items,
            venuePending || categoriesPending || itemsPending,
            venueCached || categoriesCached || itemsCached,
        ))

        val venueRegistration = firestore.collection("venues").document(venueId)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (error != null) { close(error); return@addSnapshotListener }
                venue = snapshot?.toObject(Venue::class.java)
                venuePending = snapshot?.metadata?.hasPendingWrites() == true
                venueCached = snapshot?.metadata?.isFromCache == true
                emit()
            }
        val categoryRegistration = firestore.collection("categories").whereEqualTo("venueId", venueId)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (error != null) { close(error); return@addSnapshotListener }
                categories = snapshot?.documents.orEmpty().mapNotNull { doc -> doc.toObject(MenuCategory::class.java)?.copy(id = doc.id) }
                categoriesPending = snapshot?.metadata?.hasPendingWrites() == true
                categoriesCached = snapshot?.metadata?.isFromCache == true
                emit()
            }
        val itemRegistration = firestore.collection("items").whereEqualTo("venueId", venueId)
            .addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (error != null) { close(error); return@addSnapshotListener }
                items = snapshot?.documents.orEmpty().mapNotNull { doc -> doc.toObject(MenuItem::class.java)?.copy(id = doc.id) }
                itemsPending = snapshot?.metadata?.hasPendingWrites() == true
                itemsCached = snapshot?.metadata?.isFromCache == true
                emit()
            }
        awaitClose { venueRegistration.remove(); categoryRegistration.remove(); itemRegistration.remove() }
    }

    private fun audit() = mapOf("updatedAt" to FieldValue.serverTimestamp(), "updatedBy" to (auth.currentUser?.uid ?: "unknown"))

    suspend fun setAvailability(item: MenuItem, available: Boolean) {
        firestore.collection("items").document(item.id).update(audit() + ("isAvailable" to available)).await()
    }

    suspend fun saveCategory(venueId: String, categoryId: String?, name: String, sortOrder: Int) {
        val ref = categoryId?.let { firestore.collection("categories").document(it) }
            ?: firestore.collection("categories").document()
        ref.set(audit() + mapOf("venueId" to venueId, "name" to name, "sortOrder" to sortOrder)).await()
    }

    suspend fun deleteCategory(venueId: String, categoryId: String) {
        val child = firestore.collection("items").whereEqualTo("venueId", venueId).whereEqualTo("categoryId", categoryId).limit(1).get().await()
        require(child.isEmpty) { "Сначала удалите или перенесите позиции этой категории." }
        firestore.collection("categories").document(categoryId).delete().await()
    }

    suspend fun saveItem(venueId: String, itemId: String?, categoryId: String, name: String, priceMinor: Long, sortOrder: Int, available: Boolean) {
        val ref = itemId?.let { firestore.collection("items").document(it) } ?: firestore.collection("items").document()
        ref.set(audit() + mapOf(
            "venueId" to venueId,
            "categoryId" to categoryId,
            "name" to name,
            "priceMinor" to priceMinor,
            "sortOrder" to sortOrder,
            "isAvailable" to available,
        )).await()
    }

    suspend fun importItems(venueId: String, existingCategories: List<MenuCategory>, existingItems: List<MenuItem>, rows: List<CsvMenuRow>) {
        val categoriesByName = existingCategories.associateBy { it.name.trim().lowercase() }.toMutableMap()
        val categoryRefs = mutableMapOf<String, com.google.firebase.firestore.DocumentReference>()
        val categoryOrder = existingCategories.size
        rows.map { it.category }.distinctBy { it.lowercase() }.forEachIndexed { index, name ->
            val key = name.lowercase()
            if (key !in categoriesByName) {
                val ref = firestore.collection("categories").document()
                categoryRefs[key] = ref
                categoriesByName[key] = MenuCategory(id = ref.id, venueId = venueId, name = name, sortOrder = categoryOrder + index)
            }
        }
        val nextItemOrder = existingItems.groupBy { it.categoryId }.mapValues { (_, value) -> value.size }.toMutableMap()
        val operations = mutableListOf<Pair<com.google.firebase.firestore.DocumentReference, Map<String, Any>>>()
        categoryRefs.forEach { (key, ref) ->
            val category = categoriesByName.getValue(key)
            operations += ref to (audit() + mapOf("venueId" to venueId, "name" to category.name, "sortOrder" to category.sortOrder))
        }
        rows.forEach { row ->
            val category = categoriesByName.getValue(row.category.lowercase())
            val order = nextItemOrder.getOrDefault(category.id, 0)
            nextItemOrder[category.id] = order + 1
            operations += firestore.collection("items").document() to (audit() + mapOf(
                "venueId" to venueId, "categoryId" to category.id, "name" to row.name,
                "priceMinor" to row.priceMinor, "sortOrder" to order, "isAvailable" to row.isAvailable,
            ))
        }
        operations.chunked(500).forEach { chunk ->
            firestore.batch().also { batch -> chunk.forEach { (ref, data) -> batch.set(ref, data) } }.commit().await()
        }
    }

    suspend fun deleteItem(itemId: String) { firestore.collection("items").document(itemId).delete().await() }

    suspend fun reorderCategories(categories: List<MenuCategory>) {
        val batch = firestore.batch()
        categories.forEachIndexed { index, item -> batch.update(firestore.collection("categories").document(item.id), audit() + ("sortOrder" to index)) }
        batch.commit().await()
    }

    suspend fun reorderItems(items: List<MenuItem>) {
        val batch = firestore.batch()
        items.forEachIndexed { index, item -> batch.update(firestore.collection("items").document(item.id), audit() + ("sortOrder" to index)) }
        batch.commit().await()
    }

    suspend fun updateVenue(venueId: String, name: String, backgroundColor: String, accentColor: String, duration: Int) {
        firestore.collection("venues").document(venueId).update(audit() + mapOf(
            "name" to name,
            "backgroundColor" to backgroundColor,
            "accentColor" to accentColor,
            "pageDurationSeconds" to duration,
        )).await()
    }

    suspend fun uploadLogo(venueId: String, uri: Uri) {
        val path = "venues/$venueId/logo/current"
        storage.reference.child(path).putFile(uri).await()
        firestore.collection("venues").document(venueId).update(audit() + ("logoPath" to path)).await()
    }

    suspend fun rotateDisplayLink(): String {
        val data = displayBaseUrl?.let { mapOf("displayBaseUrl" to it) } ?: emptyMap<String, String>()
        val result = functions.getHttpsCallable("rotateDisplayToken").call(data).await().data as Map<*, *>
        return result["displayUrl"] as String
    }

    suspend fun logout() { auth.signOut() }
}
