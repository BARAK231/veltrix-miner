import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { Pool } from "pg";
import { Telegraf } from "telegraf";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");

const APP_URL =
  process.env.APP_URL || "https://veltrix-miner.onrender.com";

const RATE = 4.74;
const CYCLE_HOURS = 8;
const CYCLE_SECONDS = CYCLE_HOURS * 60 * 60;
const REFERRAL_BONUS = 300;
const MIN_WITHDRAW = 10000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const bot = new Telegraf(BOT_TOKEN);

/* =========================
   DATABASE
========================= */

async function db(query, params = []) {
  return pool.query(query, params);
}

async function initDatabase() {
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      cycle_start BIGINT NOT NULL,
      wallet TEXT,
      referred_by BIGINT,
      created_at BIGINT NOT NULL
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      channel TEXT,
      reward DOUBLE PRECISION NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS task_claims (
      user_id BIGINT NOT NULL,
      task_id INTEGER NOT NULL,
      claimed_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, task_id)
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      wallet TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at BIGINT NOT NULL
    )
  `);
    await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS mining_notified_cycle BIGINT NOT NULL DEFAULT 0
  `);

  console.log("PostgreSQL database ready");
}

/* =========================
   HELPERS
========================= */

function now() {
  return Math.floor(Date.now() / 1000);
}

function calculateMining(user) {
  const elapsed = Math.max(
    0,
    Math.min(now() - Number(user.cycle_start), CYCLE_SECONDS)
  );

  return (elapsed / 3600) * RATE;
}

function remainingSeconds(user) {
  return Math.max(
    0,
    CYCLE_SECONDS - (now() - Number(user.cycle_start))
  );
}

function canClaim(user) {
  return now() - Number(user.cycle_start) >= CYCLE_SECONDS;
}

function publicUser(user) {
  const mining = calculateMining(user);

  return {
    id: String(user.id),
    username: user.username || "",
    first_name: user.first_name || "",
    balance: Number(user.balance || 0),
    mining: Number(mining.toFixed(4)),
    total: Number((Number(user.balance || 0) + mining).toFixed(4)),
    remaining: remainingSeconds(user),
    canClaim: canClaim(user),
    wallet: user.wallet || "",
    rate: RATE,
    cycleHours: CYCLE_HOURS
  };
}

/* =========================
   TELEGRAM INIT DATA
========================= */

function verifyTelegramInitData(initData) {
  if (!initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (
      calculatedHash.length !== hash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(calculatedHash),
        Buffer.from(hash)
      )
    ) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");

    if (!user.id) return null;

    return user;
  } catch (err) {
    console.error("Telegram auth error:", err);
    return null;
  }
}

function auth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  const tgUser = verifyTelegramInitData(initData);

  if (!tgUser) {
    return res.status(401).json({
      error: "Telegram authentication failed"
    });
  }

  req.tgUser = tgUser;
  next();
}

/* =========================
   USER
========================= */

async function getUser(id) {
  const result = await db(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

async function createUser(tgUser, referralId = null) {
  const existing = await getUser(tgUser.id);

  if (existing) {
    await db(
      `
      UPDATE users
      SET username = $1,
          first_name = $2
      WHERE id = $3
      `,
      [
        tgUser.username || "",
        tgUser.first_name || "",
        tgUser.id
      ]
    );

    return getUser(tgUser.id);
  }

  let referredBy = null;

  if (
    referralId &&
    String(referralId) !== String(tgUser.id)
  ) {
    const refUser = await getUser(referralId);

    if (refUser) {
      referredBy = Number(referralId);

      await db(
        `
        UPDATE users
        SET balance = balance + $1
        WHERE id = $2
        `,
        [REFERRAL_BONUS, referralId]
      );
    }
  }

  await db(
    `
    INSERT INTO users
      (id, username, first_name, balance, cycle_start, wallet, referred_by, created_at)
    VALUES
      ($1, $2, $3, 0, $4, '', $5, $4)
    `,
    [
      tgUser.id,
      tgUser.username || "",
      tgUser.first_name || "",
      now(),
      referredBy
    ]
  );

  return getUser(tgUser.id);
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await db("SELECT 1");

    res.json({
      ok: true,
      project: "VELTRIX",
      symbol: "VLX",
      rate: RATE,
      cycleHours: CYCLE_HOURS,
      database: "PostgreSQL"
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});

/* =========================
   FRONTEND
========================= */

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/web/index.html");
});

/* =========================
   USER API
========================= */

app.get("/api/user", auth, async (req, res) => {
  try {
    const ref = req.query.ref || null;

    const user = await createUser(
      req.tgUser,
      ref
    );

    res.json(publicUser(user));
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "User error"
    });
  }
});

/* =========================
   MINING
========================= */

app.get("/api/mining", auth, async (req, res) => {
  try {
    const user = await getUser(req.tgUser.id);

    if (!user) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    res.json({
      mining: Number(
        calculateMining(user).toFixed(4)
      ),
      remaining: remainingSeconds(user),
      canClaim: canClaim(user),
      rate: RATE,
      cycleHours: CYCLE_HOURS
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Mining error"
    });
  }
});

/* =========================
   CLAIM
========================= */

app.post("/api/claim", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [req.tgUser.id]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "User not found"
      });
    }

    if (!canClaim(user)) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Mining cycle is not complete"
      });
    }

    const reward = RATE * CYCLE_HOURS;

    await client.query(
      `
      UPDATE users
      SET balance = balance + $1,
          cycle_start = $2
      WHERE id = $3
      `,
      [reward, now(), req.tgUser.id]
    );

    await client.query("COMMIT");

    const updated = await getUser(req.tgUser.id);

    res.json({
      success: true,
      reward,
      user: publicUser(updated)
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(500).json({
      error: "Claim failed"
    });
  } finally {
    client.release();
  }
});

/* =========================
   TASKS
========================= */

app.get("/api/tasks", auth, async (req, res) => {
  try {
    const tasks = await db(`
      SELECT
        t.id,
        t.title,
        t.url,
        t.channel,
        t.reward,
        t.active,
        CASE
          WHEN tc.user_id IS NULL THEN false
          ELSE true
        END AS claimed
      FROM tasks t
      LEFT JOIN task_claims tc
        ON tc.task_id = t.id
       AND tc.user_id = $1
      WHERE t.active = true
      ORDER BY t.id DESC
    `, [req.tgUser.id]);

    res.json(tasks.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Tasks error"
    });
  }
});

/* =========================
   TASK CLAIM + REAL CHANNEL VERIFY
========================= */

app.post("/api/task/claim", auth, async (req, res) => {
  const taskId = Number(req.body.taskId);

  if (!taskId) {
    return res.status(400).json({
      error: "Invalid task"
    });
  }

  try {
    const taskResult = await db(
      `SELECT * FROM tasks WHERE id = $1 AND active = true`,
      [taskId]
    );

    const task = taskResult.rows[0];

    if (!task) {
      return res.status(404).json({
        error: "Task not found"
      });
    }

    const already = await db(
      `
      SELECT 1
      FROM task_claims
      WHERE user_id = $1 AND task_id = $2
      `,
      [req.tgUser.id, taskId]
    );

    if (already.rows.length) {
      return res.status(400).json({
        error: "Task already claimed"
      });
    }

    /* Real Telegram channel verification */
    if (task.channel) {
      try {
        const member = await bot.telegram.getChatMember(
          task.channel,
          req.tgUser.id
        );

        const allowed = [
          "creator",
          "administrator",
          "member"
        ];

        if (
          !allowed.includes(member.status)
        ) {
          return res.status(400).json({
            error: "Join the channel first"
          });
        }
      } catch (err) {
        console.error(
          "Channel verification error:",
          err.message
        );

        return res.status(400).json({
          error:
            "Channel verification failed. Bot must be admin."
        });
      }
    }

    await db(
      `
      INSERT INTO task_claims
        (user_id, task_id, claimed_at)
      VALUES
        ($1, $2, $3)
      `,
      [
        req.tgUser.id,
        taskId,
        now()
      ]
    );

    await db(
      `
      UPDATE users
      SET balance = balance + $1
      WHERE id = $2
      `,
      [
        Number(task.reward),
        req.tgUser.id
      ]
    );

    const user = await getUser(req.tgUser.id);

    res.json({
      success: true,
      reward: Number(task.reward),
      user: publicUser(user)
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Task claim failed"
    });
  }
});

/* =========================
   REFERRAL
========================= */

app.get("/api/referral", auth, async (req, res) => {
  try {
    const result = await db(
      `
      SELECT
        COUNT(*)::int AS count
      FROM users
      WHERE referred_by = $1
      `,
      [req.tgUser.id]
    );

    const count = result.rows[0].count;

    res.json({
      count,
      bonus: REFERRAL_BONUS,
      link:
        `https://t.me/VeltrixMinerBot?start=${req.tgUser.id}`
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Referral error"
    });
  }
});

/* =========================
   LEADERBOARD
========================= */

app.get("/api/leaderboard", auth, async (req, res) => {
  try {
    const result = await db(`
      SELECT
        id,
        username,
        first_name,
        balance
      FROM users
      ORDER BY balance DESC
      LIMIT 100
    `);

    res.json(
      result.rows.map((u, index) => ({
        rank: index + 1,
        id: String(u.id),
        username: u.username || "",
        first_name: u.first_name || "",
        balance: Number(
          Number(u.balance || 0).toFixed(4)
        )
      }))
    );
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Leaderboard error"
    });
  }
});

/* =========================
   WALLET
========================= */

app.get("/api/wallet", auth, async (req, res) => {
  try {
    const user = await getUser(req.tgUser.id);

    res.json({
      wallet: user?.wallet || ""
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Wallet error"
    });
  }
});

app.post("/api/wallet", auth, async (req, res) => {
  try {
    const wallet = String(
      req.body.wallet || ""
    ).trim();

    if (
      wallet &&
      !/^0x[a-fA-F0-9]{40}$/.test(wallet)
    ) {
      return res.status(400).json({
        error: "Invalid EVM wallet address"
      });
    }

    await db(
      `
      UPDATE users
      SET wallet = $1
      WHERE id = $2
      `,
      [
        wallet,
        req.tgUser.id
      ]
    );

    res.json({
      success: true,
      wallet
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Wallet save failed"
    });
  }
});

/* =========================
   WITHDRAW
========================= */

app.post("/api/withdraw", auth, async (req, res) => {
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount)) {
    return res.status(400).json({
      error: "Invalid amount"
    });
  }

  if (amount < MIN_WITHDRAW) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${MIN_WITHDRAW} VLX`
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [req.tgUser.id]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "User not found"
      });
    }

    if (!user.wallet) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Add your wallet first"
      });
    }

    if (Number(user.balance) < amount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient balance"
      });
    }

    const pending = await client.query(
      `
      SELECT id
      FROM withdrawals
      WHERE user_id = $1
      AND status = 'PENDING'
      LIMIT 1
      `,
      [req.tgUser.id]
    );

    if (pending.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "You already have a pending withdrawal"
      });
    }

    await client.query(
      `
      UPDATE users
      SET balance = balance - $1
      WHERE id = $2
      `,
      [
        amount,
        req.tgUser.id
      ]
    );

    await client.query(
      `
      INSERT INTO withdrawals
        (user_id, wallet, amount, status, created_at)
      VALUES
        ($1, $2, $3, 'PENDING', $4)
      `,
      [
        req.tgUser.id,
        user.wallet,
        amount,
        now()
      ]
    );

    await client.query("COMMIT");

    const updated = await getUser(req.tgUser.id);

    res.json({
      success: true,
      status: "PENDING",
      amount,
      user: publicUser(updated)
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(500).json({
      error: "Withdrawal failed"
    });
  } finally {
    client.release();
  }
});

/* =========================
   ADMIN AUTH
========================= */

function adminAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  const tgUser = verifyTelegramInitData(initData);

  if (!tgUser) {
    return res.status(401).json({
      error: "Authentication failed"
    });
  }

  if (String(tgUser.id) !== ADMIN_ID) {
    return res.status(403).json({
      error: "Admin only"
    });
  }

  req.tgUser = tgUser;
  next();
}

/* =========================
   ADMIN TASK
========================= */

app.post("/api/admin/task", adminAuth, async (req, res) => {
  try {
    const {
      title,
      url,
      channel,
      reward
    } = req.body;

    if (!title || !url) {
      return res.status(400).json({
        error: "Title and URL are required"
      });
    }

    const result = await db(
      `
      INSERT INTO tasks
        (title, url, channel, reward, active)
      VALUES
        ($1, $2, $3, $4, true)
      RETURNING *
      `,
      [
        String(title),
        String(url),
        channel ? String(channel) : null,
        Number(reward || 0)
      ]
    );

    res.json({
      success: true,
      task: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Task creation failed"
    });
  }
});

/* =========================
   ADMIN TASKS
========================= */

app.get("/api/admin/tasks", adminAuth, async (req, res) => {
  try {
    const result = await db(
      `SELECT * FROM tasks ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Admin tasks error"
    });
  }
});

/* =========================
   ADMIN TASK TOGGLE
========================= */

app.post(
  "/api/admin/task/toggle",
  adminAuth,
  async (req, res) => {
    try {
      const taskId = Number(req.body.taskId);

      const result = await db(
        `
        UPDATE tasks
        SET active = NOT active
        WHERE id = $1
        RETURNING *
        `,
        [taskId]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "Task not found"
        });
      }

      res.json({
        success: true,
        task: result.rows[0]
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Toggle failed"
      });
    }
  }
);
/* =========================
   CLEAN DUPLICATE TASKS
========================= */

app.post(
  "/api/admin/task/cleanup",
  adminAuth,
  async (req, res) => {
    try {
      const result = await db(`
        WITH duplicates AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(channel, url)
              ORDER BY id ASC
            ) AS rn
          FROM tasks
          WHERE active = true
        )
        UPDATE tasks
        SET active = false
        WHERE id IN (
          SELECT id
          FROM duplicates
          WHERE rn > 1
        )
        RETURNING *
      `);

      res.json({
        success: true,
        deactivated: result.rows.length,
        tasks: result.rows
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Cleanup failed"
      });
    }
  }
);

/* =========================
   ADMIN WITHDRAWALS
========================= */

app.get(
  "/api/admin/withdrawals",
  adminAuth,
  async (req, res) => {
    try {
      const result = await db(`
        SELECT *
        FROM withdrawals
        ORDER BY id DESC
        LIMIT 500
      `);

      res.json(result.rows);
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Withdrawals error"
      });
    }
  }
);

/* =========================
   ADMIN STATUS
========================= */

app.get(
  "/api/admin/status",
  adminAuth,
  async (req, res) => {
    try {
      const users = await db(
        `SELECT COUNT(*)::int AS count FROM users`
      );

      const withdrawals = await db(
        `
        SELECT COUNT(*)::int AS count
        FROM withdrawals
        WHERE status = 'PENDING'
        `
      );

      res.json({
        project: "VELTRIX",
        symbol: "VLX",
        rate: RATE,
        cycleHours: CYCLE_HOURS,
        referralBonus: REFERRAL_BONUS,
        minimumWithdrawal: MIN_WITHDRAW,
        users: users.rows[0].count,
        pendingWithdrawals:
          withdrawals.rows[0].count
      });
    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Admin status error"
      });
    }
  }
);

/* =========================
   TELEGRAM BOT
========================= */

bot.start(async (ctx) => {
  try {
    const payload = ctx.startPayload || null;

    const user = await createUser(
      ctx.from,
      payload
    );

    await ctx.reply(
      `⛏️ VELTRIX — VLX Miner\n\n` +
      `Rate: ${RATE} VLX/hour\n` +
      `Cycle: ${CYCLE_HOURS} hours\n\n` +
      `Open the Mini App below 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⛏️ Mine VLX",
                web_app: {
                  url:
                    `${APP_URL}?ref=${ctx.from.id}`
                }
              }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error("Bot start error:", err);
  }
});

bot.command("id", async (ctx) => {
  await ctx.reply(
    `Your Telegram ID: ${ctx.from.id}`
  );
});

/* =========================
   START SERVER
========================= */

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `VELTRIX server running on port ${PORT}`
      );
    });

    bot.launch()
      .then(() => {
        console.log("VELTRIX Telegram bot started");
      })
      .catch((err) => {
        console.error(
          "Telegram bot error:",
          err
        );
      });

  } catch (err) {
    console.error(
      "SERVER START FAILED:",
      err
    );

    process.exit(1);
  }
}

start();

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
