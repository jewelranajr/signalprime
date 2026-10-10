package com.signalprime.app

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * SignalPrime trading client — PAPER TRADING ONLY.
 * Shows engine signals and lets the user queue paper orders / close paper
 * positions through their own CryptoAI Pro server. Manual orders still pass
 * the engine's strict filters server-side (NO_TRADE stays NO_TRADE).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var urlInput: EditText
    private lateinit var signalsBox: LinearLayout
    private lateinit var paperBox: LinearLayout
    private lateinit var paperSummary: TextView

    private val prefs by lazy { getSharedPreferences("signalprime", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            setBackgroundColor(Color.parseColor("#0d1117"))
        }
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)

        // ---- header ----
        root.addView(title("⛓ SignalPrime"))
        root.addView(badge("PAPER TRADING ONLY — virtual money", "#3fb950"))
        root.addView(spacer(16))

        // ---- server ----
        root.addView(section("Server"))
        urlInput = EditText(this).apply {
            hint = "http://your-server:8080"
            setText(prefs.getString("server_url", ""))
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
        }
        root.addView(urlInput)
        val connectBtn = Button(this).apply { text = "Connect" }
        root.addView(connectBtn)
        statusText = TextView(this).apply { setTextColor(Color.GRAY) }
        root.addView(statusText)
        connectBtn.setOnClickListener { connect() }
        root.addView(spacer(16))

        // ---- signals ----
        root.addView(section("Signals"))
        val sigRefresh = Button(this).apply { text = "↻ Refresh signals" }
        root.addView(sigRefresh)
        signalsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(signalsBox)
        sigRefresh.setOnClickListener { loadSignals() }
        root.addView(spacer(16))

        // ---- paper account ----
        root.addView(section("Paper Account"))
        val paperRefresh = Button(this).apply { text = "↻ Refresh account" }
        root.addView(paperRefresh)
        paperSummary = TextView(this).apply { setTextColor(Color.WHITE) }
        root.addView(paperSummary)
        paperBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(paperBox)
        paperRefresh.setOnClickListener { loadPaper() }

        root.addView(spacer(24))
        root.addView(note("Manual orders are engine-gated: only ACTIVE A+/A signals can open. Past simulation does not predict future results."))

        // auto-connect if URL saved
        if (prefs.getString("server_url", "").isNullOrBlank().not()) connect()
    }

    // ---------- UI helpers ----------

    private fun title(t: String) = TextView(this).apply {
        text = t; textSize = 24f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.WHITE)
    }

    private fun section(t: String) = TextView(this).apply {
        text = t; textSize = 18f; setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor("#58a6ff"))
    }

    private fun badge(t: String, color: String) = TextView(this).apply {
        text = t; textSize = 12f; setTextColor(Color.parseColor(color))
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun note(t: String) = TextView(this).apply {
        text = t; textSize = 12f; setTextColor(Color.GRAY)
    }

    private fun spacer(h: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, h
        )
    }

    private fun rowCard(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(24, 20, 24, 20)
        setBackgroundColor(Color.parseColor("#161b22"))
        val p = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        p.setMargins(0, 8, 0, 8)
        layoutParams = p
    }

    private fun line(t: String, color: Int = Color.WHITE, size: Float = 14f) =
        TextView(this).apply { text = t; setTextColor(color); textSize = size }

    private fun toast(msg: String) =
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    // ---------- server ----------

    private fun connect() {
        val url = urlInput.text.toString().trim().trimEnd('/')
        if (url.isEmpty()) {
            toast("Enter your server URL first")
            return
        }
        ApiClient.baseUrl = url
        statusText.text = "connecting…"
        thread {
            try {
                val h = ApiClient.health()
                prefs.edit().putString("server_url", url).apply()
                runOnUiThread {
                    statusText.text = "✓ connected — v${h.optString("version")} (paper only)"
                    statusText.setTextColor(Color.parseColor("#3fb950"))
                }
                loadSignals()
                loadPaper()
            } catch (e: Exception) {
                runOnUiThread {
                    statusText.text = "✗ ${e.message}"
                    statusText.setTextColor(Color.parseColor("#f85149"))
                }
            }
        }
    }

    // ---------- signals ----------

    private fun loadSignals() {
        if (ApiClient.baseUrl.isEmpty()) {
            toast("Connect to a server first")
            return
        }
        thread {
            try {
                val res = ApiClient.signals(20)
                val arr = res.optJSONArray("signals")
                runOnUiThread {
                    signalsBox.removeAllViews()
                    if (arr == null || arr.length() == 0) {
                        signalsBox.addView(line("No signals right now.", Color.GRAY))
                        return@runOnUiThread
                    }
                    for (i in 0 until arr.length()) {
                        val s = arr.getJSONObject(i)
                        signalsBox.addView(signalRow(s))
                    }
                }
            } catch (e: Exception) {
                toast("signals: ${e.message}")
            }
        }
    }

    private fun signalRow(s: JSONObject): View {
        val dir = s.optString("direction", "NO_TRADE")
        val dirColor = when (dir) {
            "LONG" -> "#3fb950"
            "SHORT" -> "#f85149"
            else -> "#8b949e"
        }
        val card = rowCard()
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sym = line(s.optString("symbol"), Color.WHITE, 16f).apply {
            setTypeface(typeface, Typeface.BOLD)
        }
        val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        sym.layoutParams = params
        top.addView(sym)
        top.addView(badge(dir, dirColor))
        card.addView(top)
        card.addView(line(
            "grade ${s.optString("signal_grade")} · score ${s.optInt("score")} · conf ${s.optInt("confidence")}",
            Color.GRAY, 13f
        ))
        card.isClickable = true
        card.setOnClickListener { showSignalDetail(s) }
        return card
    }

    private fun showSignalDetail(s: JSONObject) {
        val dir = s.optString("direction")
        val canOrder = (dir == "LONG" || dir == "SHORT") &&
            s.optString("status") == "ACTIVE" &&
            (s.optString("signal_grade") == "A+" || s.optString("signal_grade") == "A")

        val msg = buildString {
            appendLine("Symbol: ${s.optString("symbol")}")
            appendLine("Direction: $dir")
            appendLine("Grade: ${s.optString("signal_grade")}")
            appendLine("Score: ${s.optInt("score")}  Confidence: ${s.optInt("confidence")}")
            appendLine("Regime: ${s.optString("market_regime")}")
            val entry = s.optJSONObject("entry")?.optDouble("preferred", Double.NaN)
            if (entry != null && !entry.isNaN() && !entry.isInfinite()) appendLine("Entry: $entry")
            val sl = s.optJSONObject("stop_loss")?.optDouble("price", Double.NaN)
            if (sl != null && !sl.isNaN() && !sl.isInfinite()) appendLine("Stop: $sl")
            if (!canOrder) appendLine("\nOrder disabled — engine filters not met.")
        }

        val dlg = AlertDialog.Builder(this)
            .setTitle("${s.optString("symbol")} signal")
            .setMessage(msg)
            .setNegativeButton("Close", null)

        if (canOrder) {
            dlg.setPositiveButton("Open PAPER order") { _, _ ->
                queueOrder(s.optString("symbol"), dir)
            }
        }
        dlg.show()
    }

    private fun queueOrder(symbol: String, direction: String) {
        thread {
            try {
                val res = ApiClient.paperOrder(symbol, direction)
                toast("queued: ${res.optString("intentId")}")
                runOnUiThread { loadPaper() }
            } catch (e: Exception) {
                toast("order rejected: ${e.message}")
            }
        }
    }

    // ---------- paper account ----------

    private fun loadPaper() {
        if (ApiClient.baseUrl.isEmpty()) return
        thread {
            try {
                val res = ApiClient.paperStatus()
                runOnUiThread {
                    if (!res.optBoolean("running", false)) {
                        paperSummary.text = "paper runner is not active"
                        paperBox.removeAllViews()
                        return@runOnUiThread
                    }
                    val acc = res.optJSONObject("account") ?: JSONObject()
                    val bal = acc.optDouble("balance", 0.0)
                    val eq = acc.optDouble("equity", 0.0)
                    val pnl = acc.optDouble("realizedPnl", 0.0)
                    paperSummary.text =
                        "Balance: ${fmt(bal)}   Equity: $${fmt(eq)}   PnL: $${fmt(pnl)}"
                    paperBox.removeAllViews()
                    val positions = acc.optJSONArray("openPositions")
                    if (positions == null || positions.length() == 0) {
                        paperBox.addView(line("No open positions.", Color.GRAY))
                    } else {
                        for (i in 0 until positions.length()) {
                            paperBox.addView(positionRow(positions.getJSONObject(i)))
                        }
                    }
                }
            } catch (e: Exception) {
                toast("paper: ${e.message}")
            }
        }
    }

    private fun positionRow(p: JSONObject): View {
        val card = rowCard()
        val dir = p.optString("direction")
        val dirColor = if (dir == "LONG") "#3fb950" else "#f85149"
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sym = line("${p.optString("symbol")}  $dir", Color.WHITE, 16f).apply {
            setTypeface(typeface, Typeface.BOLD)
        }
        sym.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(sym)
        top.addView(badge(dir, dirColor))
        card.addView(top)
        card.addView(line(
            "entry ${p.optDouble("entry")} · qty ${p.optDouble("quantity")} · SL ${p.optDouble("stopLoss")}",
            Color.GRAY, 13f
        ))
        val closeBtn = Button(this).apply {
            text = "Close position"
            setOnClickListener { closePosition(p.optString("symbol")) }
        }
        card.addView(closeBtn)
        return card
    }

    private fun closePosition(symbol: String) {
        AlertDialog.Builder(this)
            .setTitle("Close $symbol?")
            .setMessage("This closes the virtual position at market price.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Close") { _, _ ->
                thread {
                    try {
                        ApiClient.paperClose(symbol)
                        toast("close queued for $symbol")
                        Thread.sleep(2000)
                        runOnUiThread { loadPaper() }
                    } catch (e: Exception) {
                        toast("close failed: ${e.message}")
                    }
                }
            }
            .show()
    }

    private fun fmt(n: Double): String = String.format("%.2f", n)
}
