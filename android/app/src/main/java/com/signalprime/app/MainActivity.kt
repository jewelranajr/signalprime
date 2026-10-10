package com.signalprime.app

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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

    // ---- theme ----
    private val BG = "#0b0e14"
    private val CARD = "#151b26"
    private val CARD_BORDER = "#232c3d"
    private val ACCENT = "#4f8cff"
    private val GREEN = "#34d399"
    private val RED = "#f87171"
    private val MUTED = "#8b94a3"
    private val WHITE = "#f1f5f9"

    private lateinit var statusText: TextView
    private lateinit var urlInput: EditText
    private lateinit var signalsBox: LinearLayout
    private lateinit var paperBox: LinearLayout
    private lateinit var paperSummary: TextView
    private lateinit var statusDot: TextView

    private val prefs by lazy { getSharedPreferences("signalprime", Context.MODE_PRIVATE) }
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun rounded(color: String, radiusDp: Int = 14, border: String? = null): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(Color.parseColor(color))
            if (border != null) setStroke(dp(1), Color.parseColor(border))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(32))
            setBackgroundColor(Color.parseColor(BG))
        }
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)

        // ---- header ----
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val logo = TextView(this).apply {
            text = "◈"
            textSize = 30f
            setTextColor(Color.parseColor(ACCENT))
        }
        header.addView(logo)
        val titleBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, 0, 0)
        }
        titleBox.addView(TextView(this).apply {
            text = "SignalPrime"
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(WHITE))
        })
        titleBox.addView(TextView(this).apply {
            text = "PAPER TRADING  •  VIRTUAL MONEY"
            textSize = 11f
            setTextColor(Color.parseColor(GREEN))
            setTypeface(typeface, Typeface.BOLD)
        })
        header.addView(titleBox)
        // status dot (right side)
        statusDot = TextView(this).apply {
            text = "●"
            textSize = 16f
            setTextColor(Color.parseColor(MUTED))
        }
        val dotWrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        dotWrap.addView(statusDot)
        header.addView(dotWrap)
        root.addView(header)
        root.addView(spacer(18))

        // ---- server card ----
        val serverCard = card()
        serverCard.addView(section("SERVER"))
        serverCard.addView(spacer(8))
        urlInput = EditText(this).apply {
            hint = "https://your-server.onrender.com"
            setText(prefs.getString("server_url", ""))
            setTextColor(Color.parseColor(WHITE))
            setHintTextColor(Color.parseColor("#5b6577"))
            background = rounded("#0e1420", 10, CARD_BORDER)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            textSize = 14f
        }
        serverCard.addView(urlInput)
        serverCard.addView(spacer(10))
        val connectBtn = styledButton("CONNECT")
        serverCard.addView(connectBtn)
        serverCard.addView(spacer(6))
        statusText = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor(MUTED))
        }
        serverCard.addView(statusText)
        connectBtn.setOnClickListener { connect() }
        root.addView(serverCard)
        root.addView(spacer(14))

        // ---- signals card ----
        val sigCard = card()
        sigCard.addView(section("SIGNALS"))
        sigCard.addView(spacer(8))
        val sigRefresh = styledButton("↻  REFRESH SIGNALS", outlined = true)
        sigCard.addView(sigRefresh)
        sigCard.addView(spacer(8))
        signalsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        sigCard.addView(signalsBox)
        sigRefresh.setOnClickListener { loadSignals() }
        root.addView(sigCard)
        root.addView(spacer(14))

        // ---- paper account card ----
        val paperCard = card()
        paperCard.addView(section("PAPER ACCOUNT"))
        paperCard.addView(spacer(8))
        val paperRefresh = styledButton("↻  REFRESH ACCOUNT", outlined = true)
        paperCard.addView(paperRefresh)
        paperCard.addView(spacer(10))
        paperSummary = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.parseColor(WHITE))
            setLineSpacing(dp(4).toFloat(), 1f)
        }
        paperCard.addView(paperSummary)
        paperCard.addView(spacer(8))
        paperBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        paperCard.addView(paperBox)
        paperRefresh.setOnClickListener { loadPaper() }
        root.addView(paperCard)

        root.addView(spacer(18))
        root.addView(TextView(this).apply {
            text = "Manual orders are engine-gated: only ACTIVE A+/A signals can open.\nPast simulation does not predict future results."
            textSize = 11f
            setTextColor(Color.parseColor("#5b6577"))
            gravity = Gravity.CENTER
        })

        // auto-connect if URL saved
        if (prefs.getString("server_url", "").isNullOrBlank().not()) connect()
    }

    // ---------- UI helpers ----------

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(CARD, 16, CARD_BORDER)
        setPadding(dp(16), dp(16), dp(16), dp(16))
    }

    private fun section(t: String) = TextView(this).apply {
        text = t
        textSize = 12f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor(ACCENT))
        letterSpacing = 0.12f
    }

    private fun styledButton(t: String, outlined: Boolean = false): Button {
        return Button(this).apply {
            text = t
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            letterSpacing = 0.06f
            setTextColor(if (outlined) Color.parseColor(ACCENT) else Color.WHITE)
            background = if (outlined) rounded("#0e1420", 10, ACCENT)
                         else rounded(ACCENT, 10)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            isAllCaps = false
            stateListAnimator = null
        }
    }

    private fun badge(t: String, color: String): TextView = TextView(this).apply {
        text = "  $t  "
        textSize = 12f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor(color))
        background = rounded("#0e1420", 8, color)
        setPadding(dp(6), dp(4), dp(6), dp(4))
    }

    private fun spacer(h: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(h)
        )
    }

    private fun innerCard(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded("#0e1420", 12, CARD_BORDER)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        val p = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        p.setMargins(0, dp(6), 0, dp(6))
        layoutParams = p
    }

    private fun line(t: String, color: String = WHITE, size: Float = 14f, bold: Boolean = false) =
        TextView(this).apply {
            text = t
            setTextColor(Color.parseColor(color))
            textSize = size
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    private fun toast(msg: String) =
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    private fun setDot(connected: Boolean) {
        runOnUiThread {
            statusDot.setTextColor(Color.parseColor(if (connected) GREEN else MUTED))
        }
    }

    // ---------- server ----------

    private fun connect() {
        val url = urlInput.text.toString().trim().trimEnd('/')
        if (url.isEmpty()) {
            toast("Enter your server URL first")
            return
        }
        ApiClient.baseUrl = url
        statusText.text = "connecting…"
        statusText.setTextColor(Color.parseColor(MUTED))
        thread {
            try {
                val h = ApiClient.health()
                prefs.edit().putString("server_url", url).apply()
                setDot(true)
                runOnUiThread {
                    statusText.text = "✓ connected — v${h.optString("version")}  •  paper only"
                    statusText.setTextColor(Color.parseColor(GREEN))
                }
                loadSignals()
                loadPaper()
            } catch (e: Exception) {
                setDot(false)
                runOnUiThread {
                    statusText.text = "✗ ${e.message}"
                    statusText.setTextColor(Color.parseColor(RED))
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
                        signalsBox.addView(emptyState("No signals right now.\nEngine is scanning — strict filters apply."))
                        return@runOnUiThread
                    }
                    var shown = 0
                    for (i in 0 until arr.length()) {
                        val s = arr.getJSONObject(i)
                        if (s.optString("direction") == "NO_TRADE" &&
                            s.optString("status") != "ACTIVE") continue
                        signalsBox.addView(signalRow(s))
                        if (++shown >= 10) break
                    }
                    if (shown == 0) {
                        signalsBox.addView(emptyState("No actionable signals.\nAll scanned coins are NO_TRADE under strict filters."))
                    }
                }
            } catch (e: Exception) {
                toast("signals: ${e.message}")
            }
        }
    }

    private fun emptyState(t: String) = TextView(this).apply {
        text = t
        textSize = 13f
        setTextColor(Color.parseColor(MUTED))
        gravity = Gravity.CENTER
        setPadding(dp(8), dp(16), dp(8), dp(16))
        setLineSpacing(dp(4).toFloat(), 1f)
    }

    private fun signalRow(s: JSONObject): View {
        val dir = s.optString("direction", "NO_TRADE")
        val dirColor = when (dir) {
            "LONG" -> GREEN
            "SHORT" -> RED
            else -> MUTED
        }
        val card = innerCard()
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sym = line(s.optString("symbol"), WHITE, 17f, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        top.addView(sym)
        top.addView(badge(dir, dirColor))
        card.addView(top)
        card.addView(spacer(6))
        val grade = s.optString("signal_grade")
        val score = s.optInt("score")
        val conf = s.optInt("confidence")
        card.addView(line("Grade $grade   •   Score $score   •   Conf $conf%", MUTED, 13f))
        val regime = s.optString("market_regime")
        if (regime.isNotEmpty()) {
            card.addView(spacer(2))
            card.addView(line("Regime: $regime", "#5b6577", 12f))
        }
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
            appendLine("Score: ${s.optInt("score")}   Confidence: ${s.optInt("confidence")}%")
            appendLine("Regime: ${s.optString("market_regime")}")
            val entry = s.optJSONObject("entry")?.optDouble("preferred", Double.NaN)
            if (entry != null && !entry.isNaN() && !entry.isInfinite()) appendLine("Entry: $entry")
            val sl = s.optJSONObject("stop_loss")?.optDouble("price", Double.NaN)
            if (sl != null && !sl.isNaN() && !sl.isInfinite()) appendLine("Stop: $sl")
            val tp = s.optJSONObject("take_profit")?.optDouble("price", Double.NaN)
            if (tp != null && !tp.isNaN() && !tp.isInfinite()) appendLine("Target: $tp")
            if (!canOrder) appendLine("\nOrder disabled — engine filters not met.")
            else appendLine("\n✓ Engine-approved: order will be queued as PAPER.")
        }

        val dlg = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
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
                val ok = res.optBoolean("ok", false)
                if (ok) toast("✓ Paper order queued: $direction $symbol")
                else toast("Rejected: ${res.optString("reason", res.optString("error", "engine filter"))}")
                runOnUiThread { loadPaper() }
            } catch (e: Exception) {
                toast("order failed: ${e.message}")
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
                    val pnlColor = if (pnl >= 0) GREEN else RED
                    paperSummary.text = "Balance  $${fmt(bal)}      Equity  $${fmt(eq)}"
                    paperBox.removeAllViews()

                    // PnL row
                    val pnlRow = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                    }
                    pnlRow.addView(line("Realized PnL   ", MUTED, 13f))
                    pnlRow.addView(line("$${fmt(pnl)}", pnlColor, 15f, bold = true))
                    paperBox.addView(pnlRow)
                    paperBox.addView(spacer(8))

                    val positions = acc.optJSONArray("openPositions")
                    if (positions == null || positions.length() == 0) {
                        paperBox.addView(emptyState("No open positions."))
                    } else {
                        paperBox.addView(line("${positions.length()} open position(s)", MUTED, 12f))
                        paperBox.addView(spacer(4))
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
        val card = innerCard()
        val dir = p.optString("direction")
        val dirColor = if (dir == "LONG") GREEN else RED
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sym = line("${p.optString("symbol")}  $dir", WHITE, 16f, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        top.addView(sym)
        top.addView(badge(dir, dirColor))
        card.addView(top)
        card.addView(spacer(6))
        card.addView(line(
            "Entry ${p.optDouble("entry")}  •  Qty ${p.optDouble("quantity")}",
            MUTED, 13f
        ))
        card.addView(line(
            "SL ${p.optDouble("stopLoss")}  •  TP ${p.optDouble("takeProfit")}",
            "#5b6577", 12f
        ))
        card.addView(spacer(8))
        val closeBtn = styledButton("CLOSE POSITION", outlined = true).apply {
            setTextColor(Color.parseColor(RED))
            background = rounded("#0e1420", 10, RED)
            setOnClickListener { closePosition(p.optString("symbol")) }
        }
        card.addView(closeBtn)
        return card
    }

    private fun closePosition(symbol: String) {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Close $symbol?")
            .setMessage("This closes the virtual position at market price.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Close") { _, _ ->
                thread {
                    try {
                        ApiClient.paperClose(symbol)
                        toast("✓ close queued for $symbol")
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
