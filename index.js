require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://kk-dresses-frontend.vercel.app",
      "https://itsmdaftab.github.io",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* =========================
   DATABASE
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

async function safeQuery(query, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(query, params);
  } finally {
    client.release();
  }
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "KK DRESSES Backend Running" });
});

/* =========================
   SECRET CODE DECODER
========================= */
const SECRET = "NOSIMCARDK";

function decodePrice(code) {
  let price = "";
  for (let char of code.toUpperCase()) {
    const index = SECRET.indexOf(char);
    if (index === -1) return null;
    price += index + 1 === 10 ? "0" : index + 1;
  }
  return Number(price);
}

/* =========================
   AUTH
========================= */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await safeQuery(
      "SELECT role FROM users WHERE username=$1 AND password=$2",
      [username, password]
    );
    if (!result.rows.length)
      return res.status(401).json({ error: "Invalid credentials" });
    res.json({ role: result.rows[0].role });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/register-worker", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Missing fields" });

    const exists = await safeQuery(
      "SELECT 1 FROM users WHERE username=$1",
      [username]
    );
    if (exists.rows.length)
      return res.status(400).json({ error: "Username exists" });

    await safeQuery(
      "INSERT INTO users (username, password, role) VALUES ($1,$2,'WORKER')",
      [username, password]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   SINGLE SALE
========================= */
app.post("/calculate-profit", async (req, res) => {
  try {
    const {
      category,
      secretCode,
      soldPrice,
      soldBy,
      paymentMode,
      cashAmount = 0,
      onlineAmount = 0,
    } = req.body;

    const actualPrice = decodePrice(secretCode);
    if (!actualPrice)
      return res.status(400).json({ error: "Invalid secret code" });

    const profit = soldPrice - actualPrice;

    await safeQuery(
      `INSERT INTO sales
      (category, secret_code, actual_price, sold_price, profit, sold_by,
       payment_mode, cash_amount, online_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        category,
        secretCode,
        actualPrice,
        soldPrice,
        profit,
        soldBy,
        paymentMode,
        cashAmount,
        onlineAmount,
      ]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   BULK SALES
========================= */
app.post("/calculate-profit/bulk", async (req, res) => {
  const { soldBy, items } = req.body;
  const client = await pool.connect();

  try {
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: "No items provided" });

    await client.query("BEGIN");

    for (const item of items) {
      const {
        category,
        secretCode,
        soldPrice,
        paymentMode,
        cashAmount = 0,
        onlineAmount = 0,
      } = item;

      const actualPrice = decodePrice(secretCode);
      if (!actualPrice) throw new Error(`Invalid code: ${secretCode}`);

      const profit = soldPrice - actualPrice;

      await client.query(
        `INSERT INTO sales
        (category, secret_code, actual_price, sold_price, profit, sold_by,
         payment_mode, cash_amount, online_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          category,
          secretCode,
          actualPrice,
          soldPrice,
          profit,
          soldBy,
          paymentMode,
          cashAmount,
          onlineAmount,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =========================
   OWNER SUMMARY (WITH CASH / ONLINE)
========================= */
app.get("/owner/summary", async (req, res) => {
  try {
    const { range } = req.query;
    let condition = "";

    if (range === "today") {
      condition = `
        (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      `;
    } else if (range === "yesterday") {
      condition = `
        (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        = ((NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day')::date
      `;
    } else if (range === "month") {
      condition = `
        created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'
        >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    } else if (range === "year") {
      condition = `
        created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'
        >= date_trunc('year', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    }

    const result = await safeQuery(`
      SELECT
        COALESCE(SUM(sold_price),0)::int AS sales,
        COALESCE(SUM(profit),0)::int AS profit,
        COUNT(*)::int AS count,
        COALESCE(SUM(cash_amount),0)::int AS cash_total,
        COALESCE(SUM(online_amount),0)::int AS online_total
      FROM sales
      ${condition ? `WHERE ${condition}` : ""}
    `);

    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   CATEGORY STATS
========================= */
app.get("/owner/category-stats", async (_, res) => {
  const result = await safeQuery(`
    SELECT category,
           COUNT(*)::int AS count,
           COALESCE(SUM(profit),0)::int AS profit
    FROM sales
    GROUP BY category
    ORDER BY profit DESC
  `);
  res.json(result.rows);
});

/* =========================
   WORKER STATS
========================= */
app.get("/owner/worker-stats-full", async (_, res) => {
  const result = await safeQuery(`
    SELECT sold_by,
           COUNT(*)::int AS count,
           COALESCE(SUM(profit),0)::int AS profit
    FROM sales
    GROUP BY sold_by
    ORDER BY count DESC
  `);
  res.json(result.rows);
});

/* =========================
   HISTORY
========================= */
app.get("/owner/sales-history", async (_, res) => {
  const result = await safeQuery(`
    SELECT id, category, sold_price, profit, sold_by,
           secret_code, payment_mode, cash_amount, online_amount,
           created_at
    FROM sales
    ORDER BY created_at DESC
    LIMIT 50
  `);
  res.json(result.rows);
});

/* =========================
   DELETE SALE
========================= */
app.delete("/owner/delete-sale/:id", async (req, res) => {
  const result = await safeQuery("DELETE FROM sales WHERE id=$1", [
    req.params.id,
  ]);
  if (!result.rowCount)
    return res.status(404).json({ error: "Sale not found" });
  res.json({ success: true });
});

/* =========================
   EXPORT FOR VERCEL
========================= */
module.exports = app;

/* =========================
   LOCAL DEV
========================= */
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () =>
    console.log(`KK DRESSES backend running on port ${PORT}`)
  );
}
