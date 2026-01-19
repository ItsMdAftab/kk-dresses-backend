require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* =========================
   CORS CONFIG
========================= */

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://kk-dresses-frontend.vercel.app"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  })
);

app.use(express.json());

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // SESSION POOLER URL
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 15000
});

/* =========================
   SAFE QUERY HELPER
========================= */

async function safeQuery(query, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result;
  } finally {
    client.release();
  }
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("KK DRESSES Backend Running");
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
   AUTH ROUTES
========================= */

// LOGIN
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

// REGISTER WORKER
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

/* =========================
   SALES ROUTES
========================= */

// ADD SALE
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

/* =========================
   OWNER DASHBOARD ROUTES
========================= */

// TODAY SUMMARY
app.get("/owner/today-summary", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT 
        COALESCE(SUM(sold_price),0) AS total_sales,
        COALESCE(SUM(profit),0) AS total_profit
      FROM sales
      WHERE
        (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// SUMMARY (today / yesterday / month / year)
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
        COALESCE(SUM(sold_price),0) AS sales,
        COALESCE(SUM(profit),0) AS profit,
        COUNT(*)::int AS count
      FROM sales
      ${condition ? `WHERE ${condition}` : ""}
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// CATEGORY STATS
app.get("/owner/category-stats", async (req, res) => {
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
        category,
        COUNT(*)::int AS count,
        COALESCE(SUM(profit),0)::int AS profit
      FROM sales
      ${condition ? `WHERE ${condition}` : ""}
      GROUP BY category
      ORDER BY profit DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// WORKER STATS
app.get("/owner/worker-stats-full", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT
        sold_by,
        COUNT(*)::int AS count,
        COALESCE(SUM(profit),0)::int AS profit
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

// SALES HISTORY
app.get("/owner/sales-history", async (req, res) => {
  try {
    const result = await safeQuery(`
      SELECT
        category,
        sold_price,
        profit,
        sold_by,
        created_at
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

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`KK DRESSES backend running on port ${PORT}`);
});
