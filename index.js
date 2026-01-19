require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
   DATABASE CONNECTION (SAFE)
============================ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },

  max: 2,                    // VERY IMPORTANT for free tier
  idleTimeoutMillis: 5000,   // kill idle connections fast
  connectionTimeoutMillis: 15000, // tolerate cold start
});

/* ============================
   SAFE QUERY HELPER (RETRY ONCE)
============================ */

async function safeQuery(query, params = []) {
  try {
    return await pool.query(query, params);
  } catch (err) {
    console.error("DB error, retrying once...");
    return await pool.query(query, params);
  }
}

/* ============================
   BASIC HEALTH CHECK
============================ */

app.get("/", (req, res) => {
  res.send("Ladies Shop Backend Running");
});

/* ============================
   SECRET CODE DECODER
============================ */

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

/* ============================
   LOGIN (OWNER / WORKER)
============================ */

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await safeQuery(
      "SELECT role FROM users WHERE username=$1 AND password=$2",
      [username, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({ role: result.rows[0].role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   REGISTER WORKER
============================ */

app.post("/register-worker", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const exists = await safeQuery(
      "SELECT id FROM users WHERE username=$1",
      [username]
    );

    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "Username already exists" });
    }

    await safeQuery(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, 'WORKER')",
      [username, password]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   ADD SALE (WORKER)
============================ */

app.post("/calculate-profit", async (req, res) => {
  try {
    const { secretCode, soldPrice, category, soldBy } = req.body;

    if (!category || !soldBy) {
      return res.status(400).json({ error: "Category or user missing" });
    }

    const actualPrice = decodePrice(secretCode);
    if (!actualPrice) {
      return res.status(400).json({ error: "Invalid secret code" });
    }

    const profit = soldPrice - actualPrice;

    await safeQuery(
      `INSERT INTO sales 
       (category, secret_code, actual_price, sold_price, profit, sold_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [category, secretCode, actualPrice, soldPrice, profit, soldBy]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   OWNER DASHBOARD APIs
============================ */

app.get("/owner/summary", async (req, res) => {
  try {
    const { range } = req.query;
    let condition = "";

    if (range === "today") condition = "DATE(created_at) = CURRENT_DATE";
    else if (range === "yesterday")
      condition = "DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'";
    else if (range === "month")
      condition = "created_at >= DATE_TRUNC('month', CURRENT_DATE)";
    else if (range === "year")
      condition = "created_at >= DATE_TRUNC('year', CURRENT_DATE)";

    const result = await safeQuery(`
      SELECT 
        COALESCE(SUM(sold_price),0) AS sales,
        COALESCE(SUM(profit),0) AS profit,
        COUNT(*) AS count
      FROM sales
      ${condition ? `WHERE ${condition}` : ""}
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/owner/category-stats", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT category,
             COUNT(*)::int AS count,
             COALESCE(SUM(profit),0)::int AS profit
      FROM sales
      GROUP BY category
      ORDER BY profit DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/owner/worker-stats-full", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT sold_by,
             COUNT(*) AS count,
             SUM(profit) AS profit
      FROM sales
      GROUP BY sold_by
      ORDER BY count DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/owner/sales-history", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT category, sold_price, profit, sold_by, created_at
      FROM sales
      ORDER BY created_at DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   START SERVER (ALWAYS LAST)
============================ */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
