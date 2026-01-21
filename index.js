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
  } catch (err) {
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
   SINGLE SALE (KEEP)
========================= */

app.post("/calculate-profit", async (req, res) => {
  try {
    const { category, secretCode, soldPrice, soldBy } = req.body;

    const actualPrice = decodePrice(secretCode);
    if (!actualPrice)
      return res.status(400).json({ error: "Invalid secret code" });

    const profit = soldPrice - actualPrice;

    await safeQuery(
      `INSERT INTO sales
      (category, secret_code, actual_price, sold_price, profit, sold_by)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [category, secretCode, actualPrice, soldPrice, profit, soldBy]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   🔥 BULK SALES (NEW)
========================= */

app.post("/calculate-profit/bulk", async (req, res) => {
  const { soldBy, items } = req.body;
  const client = await pool.connect();

  try {
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: "No items provided" });

    await client.query("BEGIN");

    for (const item of items) {
      const { category, secretCode, soldPrice } = item;

      const actualPrice = decodePrice(secretCode);
      if (!actualPrice)
        throw new Error(`Invalid code: ${secretCode}`);

      const profit = soldPrice - actualPrice;

      await client.query(
        `INSERT INTO sales
        (category, secret_code, actual_price, sold_price, profit, sold_by)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [category, secretCode, actualPrice, soldPrice, profit, soldBy]
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
   OWNER ROUTES (UNCHANGED)
========================= */

app.get("/owner/sales-history", async (_, res) => {
  const result = await safeQuery(
    `SELECT
  id,
  category,
  sold_price,
  profit,
  sold_by,
  secret_code,
  created_at
FROM sales
ORDER BY created_at DESC
LIMIT 50
`
  );
  res.json(result.rows);
});

/* =========================
   EXPORT FOR VERCEL
========================= */

module.exports = app;
// =========================
// LOCAL DEVELOPMENT ONLY
// =========================
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`KK DRESSES backend running on port ${PORT}`);
  });
}
/* =========================
   DELETE SALE (OWNER ONLY)
========================= */
app.delete("/owner/delete-sale/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await safeQuery(
      "DELETE FROM sales WHERE id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Sale not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
