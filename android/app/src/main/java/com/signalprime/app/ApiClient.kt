package com.signalprime.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Thrown when the API answers with a non-2xx status. Carries the server's error message. */
class ApiException(message: String) : Exception(message)

/**
 * Minimal JSON HTTP client over HttpURLConnection (no external deps).
 * All endpoints are on the user's own CryptoAI Pro server (configurable URL).
 */
object ApiClient {
    var baseUrl: String = ""

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15000
            readTimeout = 90000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = try {
            stream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            ""
        }
        conn.disconnect()
        val json = if (text.isBlank()) JSONObject() else JSONObject(text)
        if (code !in 200..299) {
            throw ApiException(json.optString("error", "HTTP $code"))
        }
        return json
    }

    fun get(path: String): JSONObject = request("GET", path)
    fun post(path: String, body: JSONObject): JSONObject = request("POST", path, body)

    // ---- API wrappers ------------------------------------------------------

    fun health(): JSONObject = get("/api/health")

    fun signals(limit: Int = 20): JSONObject = get("/api/signals?limit=$limit")

    fun paperStatus(): JSONObject = get("/api/paper/status")

    fun paperIntents(): JSONObject = get("/api/paper/intents")

    fun paperOrder(symbol: String, direction: String): JSONObject =
        post("/api/paper/order", JSONObject().put("symbol", symbol).put("direction", direction))

    fun paperClose(symbol: String): JSONObject =
        post("/api/paper/close", JSONObject().put("symbol", symbol))
}
