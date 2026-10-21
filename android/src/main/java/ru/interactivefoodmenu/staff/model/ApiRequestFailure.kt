package ru.interactivefoodmenu.staff.model

class ApiRequestFailure(val status: Int, message: String) : IllegalStateException(message)
