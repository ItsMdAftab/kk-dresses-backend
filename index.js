require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* =========================
   CORS CONFIG (FIXED)
========================= */

const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://kk-dresses-frontend.vercel.app",
    "https://itsmdaftab.github.io"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// 🔑 IMPORTANT: Explicit OPTIONS handler (Vercel fix)
app.options("/calculate-profit", cors(corsOptions));
app.options("/login", cors(corsOptions));
app.options("/register-worker", cors(corsOptions));

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json());

// Extra safety headers (recommended for Vercel)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

/* =========================
   SAFE QUERY
========================= */

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
  res.send("KK DRESSES Backend Running ✅");
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
   SALES ROUTE (IMPORTANT)
========================= */

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
   START SERVER
========================= */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`KK DRESSES backend running on port ${PORT}`);
});
