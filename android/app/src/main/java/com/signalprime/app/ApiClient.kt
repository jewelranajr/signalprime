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

    // ---- Binance public price (for per-position unrealized PnL) ----

    /**
     * Fetch current spot prices for the given symbols from Binance public API.
     * Tries api.binance.com first, falls back to data-api.binance.vision (geo-block workaround).
     * Returns map symbol -> price. Symbols with no price are omitted.
     */
    fun binancePrices(symbols: List<String>): Map<String, Double> {
        if (symbols.isEmpty()) return emptyMap()
        val encoded = symbols.joinToString(",") { "%22$it%22" }
        val path = "/api/v3/ticker/price?symbols=[$encoded]"
        for (host in listOf("https://api.binance.com", "https://data-api.binance.vision")) {
            try {
                val url = URL(host + path)
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 10000
                    readTimeout = 15000
                }
                val code = conn.responseCode
                if (code !in 200..299) { conn.disconnect(); continue }
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                conn.disconnect()
                val arr = org.json.JSONArray(text)
                val out = mutableMapOf<String, Double>()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    out[o.optString("symbol")] = o.optDouble("price", Double.NaN)
                }
                return out.filterValues { !it.isNaN() }
            } catch (_: Exception) {
                continue
            }
        }
        return emptyMap()
    }
}
