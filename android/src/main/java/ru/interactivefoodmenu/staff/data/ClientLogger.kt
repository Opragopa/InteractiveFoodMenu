package ru.interactivefoodmenu.staff.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Sends small, redacted diagnostics to reportClientLog without blocking the UI. */
class ClientLogger(private val repository: MenuRepository) {
    fun error(event: String, error: Throwable, details: Map<String, Any> = emptyMap()) {
        submit("error", event, "${error::class.java.simpleName}: ${error.message.orEmpty()}", details)
    }

    private fun submit(level: String, event: String, message: String, details: Map<String, Any>) {
        val safeMessage = redact(message, 500)
        val safeDetails = details.entries.take(12).associate { (key, value) -> key.take(40) to redact(value, 200) }
        Log.e("ClientLogger", "$event: $safeMessage")
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { repository.log(level, "$event: $safeMessage", safeDetails) }
                .onFailure { Log.w("ClientLogger", "Could not send $event", it) }
        }
    }

    private fun redact(value: Any?, limit: Int): String = value.toString()
        .replace(Regex("(?i)(pin|secret|token|password)=[^\\s&]+"), "$1=[redacted]")
        .replace(Regex("#[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{20,}"), "#[redacted]")
        .take(limit)
}
