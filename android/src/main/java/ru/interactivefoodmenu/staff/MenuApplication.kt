package ru.interactivefoodmenu.staff

import android.app.Application
import ru.interactivefoodmenu.staff.data.MenuRepository
import ru.interactivefoodmenu.staff.data.ClientLogger
import ru.interactivefoodmenu.staff.data.VenuePreferences

class MenuApplication : Application() {
    lateinit var repository: MenuRepository
        private set
    lateinit var preferences: VenuePreferences
        private set
    lateinit var clientLogger: ClientLogger
        private set

    override fun onCreate() {
        super.onCreate()
        preferences = VenuePreferences(this)
        repository = MenuRepository(BuildConfig.BACKEND_API_URL)
        clientLogger = ClientLogger(repository)
    }
}
