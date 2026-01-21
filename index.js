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
  res.json({ status: "KK GROUP backend running" });
});


/* =========================
   SECRET CODE DECODER
========================= */
const SECRET = "NOSIMCARDK";

/*
  N O S I M C A R D K
  1 2 3 4 5 6 7 8 9 0
*/
function decodePrice(code) {
  if (!code) return null;

  let price = "";

  for (const char of code.toUpperCase()) {
    const index = SECRET.indexOf(char);
    if (index === -1) return null;

    // 10th character becomes 0
    price += index === 9 ? "0" : String(index + 1);
  }

  return Number(price);
}


/* =========================
   AUTH — LOGIN
========================= */
app.post("/login", async (req, res) => {
  try {
    const { username, password, shop } = req.body;

    if (!username || !password || !shop) {
      return res.status(400).json({ error: "Missing login fields" });
    }

    const result = await safeQuery(
      `
      SELECT u.role, u.shop_id
      FROM users u
      JOIN shops s ON s.id = u.shop_id
      WHERE u.username = $1
        AND u.password = $2
        AND s.name = $3
      `,
      [username, password, shop]
    );

    if (!result.rows.length) {
      return res
        .status(401)
        .json({ error: "Invalid credentials or shop" });
    }

    res.json({
      role: result.rows[0].role,
      shop_id: result.rows[0].shop_id,
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   AUTH — REGISTER WORKER
========================= */
app.post("/register-worker", async (req, res) => {
  try {
    const { username, password, ownerUsername } = req.body;

    if (!username || !password || !ownerUsername) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 🔐 Get shop_id from OWNER (not frontend)
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [ownerUsername]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    // Check if worker username already exists
    const exists = await safeQuery(
      "SELECT 1 FROM users WHERE username=$1",
      [username]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // ✅ Insert worker with owner's shop_id
    await safeQuery(
      `
      INSERT INTO users (username, password, role, shop_id)
      VALUES ($1, $2, 'WORKER', $3)
      `,
      [username, password, shop_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("REGISTER WORKER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   SALES — SINGLE SALE (SECURE)
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

    if (!category || !secretCode || !soldPrice || !soldBy) {
      return res.status(400).json({ error: "Missing sale fields" });
    }

    // 🔐 Resolve shop_id from user (OWNER or WORKER)
    const userResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1",
      [soldBy]
    );

    if (!userResult.rows.length) {
      return res.status(403).json({ error: "Invalid user" });
    }

    const shop_id = userResult.rows[0].shop_id;

    const actualPrice = decodePrice(secretCode);
    if (!actualPrice) {
      return res.status(400).json({ error: "Invalid secret code" });
    }

    const profit = Number(soldPrice) - actualPrice;

    await safeQuery(
      `
      INSERT INTO sales
      (category, secret_code, actual_price, sold_price, profit, sold_by,
       payment_mode, cash_amount, online_amount, shop_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        category,
        secretCode,
        actualPrice,
        Number(soldPrice),
        profit,
        soldBy,
        paymentMode,
        Number(cashAmount),
        Number(onlineAmount),
        shop_id,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("SINGLE SALE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


/* =========================
   SALES — BULK SALES (SECURE + TRANSACTION)
========================= */
app.post("/calculate-profit/bulk", async (req, res) => {
  const client = await pool.connect();

  try {
    const { soldBy, items } = req.body;

    if (!soldBy || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "Invalid bulk sale data" });
    }

    // 🔐 Resolve shop_id from user (OWNER or WORKER)
    const userResult = await client.query(
      "SELECT shop_id FROM users WHERE username=$1",
      [soldBy]
    );

    if (!userResult.rows.length) {
      return res.status(403).json({ error: "Invalid user" });
    }

    const shop_id = userResult.rows[0].shop_id;

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

      if (!category || !secretCode || !soldPrice) {
        throw new Error("Missing item fields");
      }

      const actualPrice = decodePrice(secretCode);
      if (!actualPrice) {
        throw new Error(`Invalid secret code: ${secretCode}`);
      }

      const profit = Number(soldPrice) - actualPrice;

      await client.query(
        `
        INSERT INTO sales
        (category, secret_code, actual_price, sold_price, profit, sold_by,
         payment_mode, cash_amount, online_amount, shop_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          category,
          secretCode,
          actualPrice,
          Number(soldPrice),
          profit,
          soldBy,
          paymentMode,
          Number(cashAmount),
          Number(onlineAmount),
          shop_id,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("BULK SALE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =========================
   OWNER — SUMMARY (SHOP SAFE)
========================= */
app.get("/owner/summary", async (req, res) => {
  try {
    const { username, range } = req.query;

    if (!username) {
      return res.status(400).json({ error: "Missing username" });
    }

    // 🔐 Resolve shop_id from OWNER
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [username]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    let dateCondition = "";

    if (range === "today") {
      dateCondition = `
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date =
            (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      `;
    } else if (range === "yesterday") {
      dateCondition = `
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date =
            ((NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day')::date
      `;
    } else if (range === "month") {
      dateCondition = `
        AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata' >=
            date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    } else if (range === "year") {
      dateCondition = `
        AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata' >=
            date_trunc('year', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    }

    const result = await safeQuery(
      `
      SELECT
        COALESCE(SUM(sold_price),0)::int AS sales,
        COALESCE(SUM(profit),0)::int AS profit,
        COUNT(*)::int AS count,
        COALESCE(SUM(cash_amount),0)::int AS cash_total,
        COALESCE(SUM(online_amount),0)::int AS online_total
      FROM sales
      WHERE shop_id = $1
      ${dateCondition}
      `,
      [shop_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("OWNER SUMMARY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});
/* =========================
   OWNER — CATEGORY STATS (SHOP SAFE)
========================= */
app.get("/owner/category-stats", async (req, res) => {
  try {
    const { username, range } = req.query;

    if (!username) {
      return res.status(400).json({ error: "Missing username" });
    }

    // 🔐 Resolve shop_id from OWNER
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [username]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    let dateCondition = "";

    if (range === "today") {
      dateCondition = `
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date =
            (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      `;
    } else if (range === "yesterday") {
      dateCondition = `
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date =
            ((NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day')::date
      `;
    } else if (range === "month") {
      dateCondition = `
        AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata' >=
            date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    } else if (range === "year") {
      dateCondition = `
        AND created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata' >=
            date_trunc('year', NOW() AT TIME ZONE 'Asia/Kolkata')
      `;
    }

    const result = await safeQuery(
      `
      SELECT
        category,
        COUNT(*)::int AS count,
        COALESCE(SUM(sold_price),0)::int AS sales,
        COALESCE(SUM(profit),0)::int AS profit
      FROM sales
      WHERE shop_id = $1
      ${dateCondition}
      GROUP BY category
      ORDER BY sales DESC
      `,
      [shop_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("CATEGORY STATS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


/* =========================
   OWNER — WORKER STATS (SHOP SAFE)
========================= */
app.get("/owner/worker-stats-full", async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({ error: "Missing username" });
    }

    // 🔐 Resolve shop_id from OWNER
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [username]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    const result = await safeQuery(
      `
      SELECT
        sold_by,
        COUNT(*)::int AS count,
        COALESCE(SUM(profit),0)::int AS profit
      FROM sales
      WHERE shop_id = $1
      GROUP BY sold_by
      ORDER BY count DESC
      `,
      [shop_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("WORKER STATS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   OWNER — SALES HISTORY (SHOP SAFE)
========================= */
app.get("/owner/sales-history", async (req, res) => {
  try {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({ error: "Missing username" });
    }

    // 🔐 Resolve shop_id from OWNER
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [username]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    const result = await safeQuery(
      `
      SELECT
        id,
        category,
        sold_price,
        profit,
        sold_by,
        secret_code,
        payment_mode,
        cash_amount,
        online_amount,
        created_at
      FROM sales
      WHERE shop_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [shop_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("SALES HISTORY ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   OWNER — DELETE SALE (SHOP SAFE)
========================= */
app.delete("/owner/delete-sale/:id", async (req, res) => {
  try {
    const { username } = req.query;
    const saleId = req.params.id;

    if (!username) {
      return res.status(400).json({ error: "Missing username" });
    }

    // 🔐 Resolve shop_id from OWNER
    const ownerResult = await safeQuery(
      "SELECT shop_id FROM users WHERE username=$1 AND role='OWNER'",
      [username]
    );

    if (!ownerResult.rows.length) {
      return res.status(403).json({ error: "Invalid owner" });
    }

    const shop_id = ownerResult.rows[0].shop_id;

    const result = await safeQuery(
      "DELETE FROM sales WHERE id=$1 AND shop_id=$2",
      [saleId, shop_id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Sale not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE SALE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = app;





