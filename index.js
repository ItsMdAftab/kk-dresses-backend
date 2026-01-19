require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* =========================
   CORS CONFIG (VERY IMPORTANT)
========================= */

app.use(
  cors({
    origin: [
      "http://localhost:3000", // local frontend
      "https://kk-dresses-frontend.vercel.app" // deployed frontend (future)
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  })
);

// 🔑 REQUIRED for Vercel preflight
app.options("*", cors());

app.use(express.json());

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 15000
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Ladies Shop Backend Running");
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
   ROUTES
========================= */

// 🔐 LOGIN
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
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

// 🧾 REGISTER WORKER
app.post("/register-worker", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE username=$1",
      [username]
    );

    if (exists.rows.length > 0) {
      return res.status(400).json({ error: "Username already exists" });
    }

    await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, 'WORKER')",
      [username, password]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 💰 CALCULATE PROFIT
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

    await pool.query(
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

// 📊 OWNER – TODAY SUMMARY
app.get("/owner/today-summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COALESCE(SUM(sold_price),0) AS total_sales,
        COALESCE(SUM(profit),0) AS total_profit
      FROM sales
      WHERE DATE(created_at) = CURRENT_DATE
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 📈 OWNER – MONTHLY SALES
app.get("/owner/monthly-sales", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        DATE(created_at) AS date,
        SUM(sold_price) AS sales,
        SUM(profit) AS profit
      FROM sales
      WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 📂 OWNER – CATEGORY STATS
app.get("/owner/category-stats", async (req, res) => {
  try {
    const { range } = req.query;

    let condition = "";
    if (range === "today") condition = "DATE(created_at) = CURRENT_DATE";
    else if (range === "yesterday") condition = "DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'";
    else if (range === "month") condition = "created_at >= DATE_TRUNC('month', CURRENT_DATE)";
    else if (range === "year") condition = "created_at >= DATE_TRUNC('year', CURRENT_DATE)";

    const result = await pool.query(`
      SELECT category,
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

/* =========================
   EXPORT FOR VERCEL
========================= */

module.exports = app;
