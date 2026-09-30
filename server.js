import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { Telegraf } from "telegraf";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const APP_URL =
  process.env.APP_URL || "https://veltrix-miner.onrender.com";

/* =========================
   VELTRIX SETTINGS
========================= */

const RATE = 1.25;
const CYCLE_HOURS = 8;
const CYCLE_SECONDS = CYCLE_HOURS * 3600;

const REFERRAL_BONUS = 300;
const MIN_WITHDRAW = 10000;

/* =========================
   PRESALE SETTINGS
========================= */

const PRESALE_RATE = 5000;
const PRESALE_ALLOCATION = 150000000;

const PRESALE_TON_ADDRESS =
  "UQASlSXzQBNaRnFNLgui-XpLqZ4NNuTUODRsBAm--sAph8u";

const PRESALE_ORDER_TTL = 30 * 60;

const TONCENTER_API_KEY =
  process.env.TONCENTER_API_KEY || "";

/* =========================
   DATABASE
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const db = (query, params = []) => pool.query(query, params);

const now = () => Math.floor(Date.now() / 1000);

/* =========================
   MINING HELPERS
========================= */

function miningAmount(user) {
  const elapsed = Math.max(
    0,
    Math.min(
      now() - Number(user.cycle_start || now()),
      CYCLE_SECONDS
    )
  );

  return (elapsed / 3600) * RATE;
}

function remaining(user) {
  return Math.max(
    0,
    CYCLE_SECONDS -
      (now() - Number(user.cycle_start || now()))
  );
}

function ready(user) {
  return remaining(user) === 0;
}

/* =========================
   PUBLIC USER
========================= */

function publicUser(user) {
  return {
    id: Number(user.id),
    username: user.username || "",
    first_name: user.first_name || "",

    balance: Number(user.balance || 0),

    presaleBalance: Number(
      user.presale_balance || 0
    ),

    mining: miningAmount(user),

    total:
      Number(user.balance || 0) +
      miningAmount(user),

    remaining: remaining(user),

    canClaim: ready(user),

    wallet: user.wallet || "",

    rate: RATE,

    cycleHours: CYCLE_HOURS,
  };
}

/* =========================
   TELEGRAM AUTH
========================= */

function verifyTelegramInitData(initData) {
  try {
    if (!initData || !BOT_TOKEN) {
      return null;
    }

    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
      return null;
    }

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

    return JSON.parse(
      params.get("user") || "null"
    );
  } catch {
    return null;
  }
}

function initData(req) {
  return (
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-web-app-data"] ||
    ""
  );
}

function auth(req, res, next) {
  const user = verifyTelegramInitData(
    initData(req)
  );

  if (!user?.id) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  req.tgUser = user;

  next();
}

function adminAuth(req, res, next) {
  const user = verifyTelegramInitData(
    initData(req)
  );

  if (!user?.id) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  if (String(user.id) !== ADMIN_ID) {
    return res.status(403).json({
      ok: false,
      error: "Admin only",
    });
  }

  req.tgUser = user;

  next();
}

/* =========================
   CREATE USER
========================= */

async function createUser(tg, ref = null) {
  const id = Number(tg.id);

  const old = await db(
    "SELECT * FROM users WHERE id=$1",
    [id]
  );

  if (old.rows.length) {
    return old.rows[0];
  }

  let referredBy = null;

  if (
    ref &&
    String(ref) !== String(id) &&
    /^\d+$/.test(String(ref))
  ) {
    const refUser = await db(
      "SELECT id FROM users WHERE id=$1",
      [Number(ref)]
    );

    if (refUser.rows.length) {
      referredBy = Number(ref);
    }
  }

  const result = await db(
    `
    INSERT INTO users
    (
      id,
      username,
      first_name,
      balance,
      cycle_start,
      wallet,
      referred_by,
      created_at
    )
    VALUES
    (
      $1,
      $2,
      $3,
      0,
      $4,
      NULL,
      $5,
      $6
    )
    RETURNING *
    `,
    [
      id,
      tg.username || null,
      tg.first_name || "",
      now(),
      referredBy,
      now(),
    ]
  );

  if (referredBy) {
    await db(
      `
      UPDATE users
      SET balance = balance + $1
      WHERE id = $2
      `,
      [
        REFERRAL_BONUS,
        referredBy,
      ]
    );
  }

  return result.rows[0];
}

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initDatabase() {
  await db(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance DOUBLE PRECISION DEFAULT 0,
      cycle_start BIGINT,
      wallet TEXT,
      referred_by BIGINT,
      created_at BIGINT
    )
  `);

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
    mining_notified_cycle BIGINT DEFAULT 0
  `);

  await db(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
    presale_balance DOUBLE PRECISION DEFAULT 0
  `);

  /* =========================
     TASKS
  ========================= */

  await db(`
    CREATE TABLE IF NOT EXISTS tasks(
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      reward DOUBLE PRECISION NOT NULL DEFAULT 0,
      type TEXT DEFAULT 'telegram',
      target TEXT,
      target_id TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at BIGINT NOT NULL
    )
  `);

  await db(`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS
    type TEXT DEFAULT 'telegram'
  `);

  await db(`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS
    target_id TEXT
  `);

  /* =========================
     REMOVE OLD X TASKS ONLY
  ========================= */

  await db(`
    DELETE FROM tasks
    WHERE type IN ('x_follow','x_repost')
  `);

  /* =========================
     TASK CLAIMS
  ========================= */

  await db(`
    CREATE TABLE IF NOT EXISTS task_claims(
      user_id BIGINT NOT NULL,
      task_id INTEGER NOT NULL,
      claimed_at BIGINT NOT NULL,
      PRIMARY KEY(user_id,task_id)
    )
  `);

  /* =========================
     WITHDRAWALS
  ========================= */

  await db(`
    CREATE TABLE IF NOT EXISTS withdrawals(
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      wallet TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at BIGINT NOT NULL,
      processed_at BIGINT,
      tx_hash TEXT
    )
  `);

  /* =========================
     PRESALE ORDERS
  ========================= */

  await db(`
    CREATE TABLE IF NOT EXISTS presale_orders(
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      ton_amount DOUBLE PRECISION NOT NULL,
      vlx_amount DOUBLE PRECISION NOT NULL,
      wallet TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at BIGINT NOT NULL,
      verified_at BIGINT
    )
  `);

  await db(`
    ALTER TABLE presale_orders
    ALTER COLUMN tx_hash DROP NOT NULL
  `).catch(() => {});

  await db(`
    ALTER TABLE presale_orders
    ADD COLUMN IF NOT EXISTS
    verified_at BIGINT
  `);

  await db(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    presale_orders_tx_hash_unique
    ON presale_orders(tx_hash)
    WHERE tx_hash IS NOT NULL
  `).catch(() => {});
}

/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  async (req, res) => {
    try {
      await db("SELECT 1");

      res.json({
        ok: true,
        project: "VELTRIX",
        symbol: "VLX",
        rate: RATE,
        cycleHours: CYCLE_HOURS,

        presale: {
          rate: PRESALE_RATE,
          allocation: PRESALE_ALLOCATION,
        },
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   TON CONNECT MANIFEST
========================= */

app.get(
  "/tonconnect-manifest.json",
  (req, res) => {
    res.json({
      url: APP_URL,
      name: "VELTRIX",
      iconUrl:
        "https://i.ibb.co/9jywd9N/grok-image-atf6l.jpg",
    });
  }
);

/* =========================
   FRONTEND
========================= */

app.get("/", (req, res) => {
  try {
    const filePath = path.join(
      __dirname,
      "web",
      "index.html"
    );

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .send("VELTRIX Mini App not found");
    }

    const html = fs.readFileSync(
      filePath,
      "utf8"
    );

    res.send(html);
  } catch (error) {
    console.error(error);

    res
      .status(500)
      .send("VELTRIX server error");
  }
});

/* =========================
   USER
========================= */

app.get(
  "/api/user",
  auth,
  async (req, res) => {
    try {
      const user = await createUser(
        req.tgUser,
        req.query.ref
      );

      res.json({
        ok: true,
        user: publicUser(user),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   MINING
========================= */

app.get(
  "/api/mining",
  auth,
  async (req, res) => {
    try {
      const user = await createUser(
        req.tgUser
      );

      res.json({
        ok: true,
        mining: miningAmount(user),
        remaining: remaining(user),
        canClaim: ready(user),
        rate: RATE,
        cycleHours: CYCLE_HOURS,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   CLAIM MINING
========================= */

app.post(
  "/api/claim",
  auth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
        SELECT *
        FROM users
        WHERE id=$1
        FOR UPDATE
        `,
        [Number(req.tgUser.id)]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "User not found",
        });
      }

      const user = result.rows[0];

      if (!ready(user)) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            "Mining cycle is not complete",
          remaining: remaining(user),
        });
      }

      const reward =
        RATE * CYCLE_HOURS;

      const updated =
        await client.query(
          `
          UPDATE users
          SET
            balance = balance + $1,
            cycle_start = $2,
            mining_notified_cycle = 0
          WHERE id = $3
          RETURNING *
          `,
          [
            reward,
            now(),
            Number(req.tgUser.id),
          ]
        );

      await client.query("COMMIT");

      res.json({
        ok: true,
        reward,
        user: publicUser(
          updated.rows[0]
        ),
      });
    } catch (error) {
      await client.query("ROLLBACK");

      res.status(500).json({
        ok: false,
        error: "Claim failed",
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   TELEGRAM TASKS
========================= */

app.get(
  "/api/tasks",
  auth,
  async (req, res) => {
    try {
      const result = await db(
        `
        SELECT
          t.*,
          CASE
            WHEN tc.user_id IS NULL
            THEN FALSE
            ELSE TRUE
          END AS claimed
        FROM tasks t

        LEFT JOIN task_claims tc
          ON tc.task_id=t.id
          AND tc.user_id=$1

        WHERE
          t.active=TRUE
          AND t.type='telegram'

        ORDER BY t.id
        `,
        [Number(req.tgUser.id)]
      );

      res.json({
        ok: true,

        tasks: result.rows.map(
          (task) => ({
            id: Number(task.id),
            title: task.title,
            description:
              task.description || "",
            reward: Number(
              task.reward || 0
            ),
            type: "telegram",
            target:
              task.target || "",
            targetId:
              task.target_id || "",
            claimed:
              Boolean(task.claimed),
          })
        ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

let bot = null;

/* =========================
   CLAIM TELEGRAM TASK
========================= */

app.post(
  "/api/task/claim",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const taskId = Number(
        req.body.taskId
      );

      const userId = Number(
        req.tgUser.id
      );

      const taskResult =
        await client.query(
          `
          SELECT *
          FROM tasks
          WHERE
            id=$1
            AND active=TRUE
            AND type='telegram'
          `,
          [taskId]
        );

      if (!taskResult.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "Task not found",
        });
      }

      const task =
        taskResult.rows[0];

      const oldClaim =
        await client.query(
          `
          SELECT 1
          FROM task_claims
          WHERE
            user_id=$1
            AND task_id=$2
          `,
          [
            userId,
            taskId,
          ]
        );

      if (oldClaim.rows.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Task already claimed",
        });
      }

      if (!bot) {
        return res.status(503).json({
          ok: false,
          error:
            "Bot not ready",
        });
      }

      const chat =
        task.target_id ||
        task.target;

      let member;

      try {
        member =
          await bot.telegram.getChatMember(
            chat,
            userId
          );
      } catch (error) {
        return res.status(400).json({
          ok: false,
          error:
            "Membership verification failed. Make sure the bot is admin in the channel.",
        });
      }

      const allowedStatuses = [
        "creator",
        "administrator",
        "member",
        "restricted",
      ];

      if (
        !allowedStatuses.includes(
          member.status
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Please join the Telegram channel first.",
        });
      }

      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO task_claims
        (
          user_id,
          task_id,
          claimed_at
        )
        VALUES
        ($1,$2,$3)
        `,
        [
          userId,
          taskId,
          now(),
        ]
      );

      await client.query(
        `
        UPDATE users
        SET balance=balance+$1
        WHERE id=$2
        `,
        [
          Number(
            task.reward || 0
          ),
          userId,
        ]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        reward: Number(
          task.reward || 0
        ),
      });
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error:
          "Task claim failed",
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   REFERRAL
========================= */

app.get(
  "/api/referral",
  auth,
  async (req, res) => {
    try {
      const userId =
        Number(req.tgUser.id);

      const result =
        await db(
          `
          SELECT COUNT(*)::int AS count
          FROM users
          WHERE referred_by=$1
          `,
          [userId]
        );

      const referrals =
        Number(
          result.rows[0]?.count || 0
        );

      res.json({
        ok: true,

        referrals,

        bonus:
          referrals *
          REFERRAL_BONUS,

        referralBonus:
          REFERRAL_BONUS,

        link:
          `https://t.me/VeltrixMinerBot?start=${userId}`,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   LEADERBOARD
========================= */

app.get(
  "/api/leaderboard",
  auth,
  async (req, res) => {
    try {
      const result =
        await db(
          `
          SELECT
            id,
            username,
            first_name,
            balance
          FROM users
          ORDER BY balance DESC
          LIMIT 100
          `
        );

      res.json({
        ok: true,

        leaderboard:
          result.rows.map(
            (user, index) => ({
              rank: index + 1,
              id: Number(
                user.id
              ),
              username:
                user.username || "",
              first_name:
                user.first_name || "",
              balance:
                Number(
                  user.balance || 0
                ),
            })
          ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   SOLANA WALLET
========================= */

function validSolana(wallet) {
  return (
    typeof wallet === "string" &&
    wallet.length >= 32 &&
    wallet.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(
      wallet
    )
  );
}

app.get(
  "/api/wallet",
  auth,
  async (req, res) => {
    try {
      const result =
        await db(
          `
          SELECT wallet
          FROM users
          WHERE id=$1
          `,
          [
            Number(
              req.tgUser.id
            ),
          ]
        );

      res.json({
        ok: true,
        wallet:
          result.rows[0]
            ?.wallet || "",
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

app.post(
  "/api/wallet",
  auth,
  async (req, res) => {
    try {
      const wallet =
        String(
          req.body.wallet || ""
        ).trim();

      if (!validSolana(wallet)) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid Solana wallet address",
        });
      }

      await db(
        `
        UPDATE users
        SET wallet=$1
        WHERE id=$2
        `,
        [
          wallet,
          Number(
            req.tgUser.id
          ),
        ]
      );

      res.json({
        ok: true,
        wallet,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   WITHDRAW
========================= */

app.post(
  "/api/withdraw",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const amount =
        Number(req.body.amount);

      const userId =
        Number(req.tgUser.id);

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid amount",
        });
      }

      if (
        amount <
        MIN_WITHDRAW
      ) {
        return res.status(400).json({
          ok: false,
          error:
            `Minimum withdrawal is ${MIN_WITHDRAW} VLX`,
        });
      }

      await client.query("BEGIN");

      const result =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE id=$1
          FOR UPDATE
          `,
          [userId]
        );

      if (!result.rows.length) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          ok: false,
          error:
            "User not found",
        });
      }

      const user =
        result.rows[0];

      if (
        !validSolana(
          user.wallet || ""
        )
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error:
            "Please add a valid Solana wallet first",
        });
      }

      if (
        Number(
          user.balance || 0
        ) < amount
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error:
            "Insufficient VLX balance",
        });
      }

      const pending =
        await client.query(
          `
          SELECT id
          FROM withdrawals
          WHERE
            user_id=$1
            AND status='PENDING'
          LIMIT 1
          `,
          [userId]
        );

      if (pending.rows.length) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          ok: false,
          error:
            "You already have a pending withdrawal",
        });
      }

      await client.query(
        `
        UPDATE users
        SET balance=balance-$1
        WHERE id=$2
        `,
        [
          amount,
          userId,
        ]
      );

      const withdrawal =
        await client.query(
          `
          INSERT INTO withdrawals
          (
            user_id,
            amount,
            wallet,
            status,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            'PENDING',
            $4
          )
          RETURNING *
          `,
          [
            userId,
            amount,
            user.wallet,
            now(),
          ]
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        withdrawal:
          withdrawal.rows[0],
      });
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error:
          "Withdrawal failed",
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   PRESALE HELPERS
========================= */

async function expireOrders() {
  await db(
    `
    UPDATE presale_orders
    SET status='EXPIRED'
    WHERE
      status='PENDING'
      AND created_at<$1
    `,
    [
      now() -
        PRESALE_ORDER_TTL,
    ]
  );
}

async function sold() {
  const result =
    await db(
      `
      SELECT
        COALESCE(
          SUM(vlx_amount),
          0
        ) AS sold
      FROM presale_orders
      WHERE status='APPROVED'
      `
    );

  return Number(
    result.rows[0]?.sold || 0
  );
}

async function reserved() {
  const result =
    await db(
      `
      SELECT
        COALESCE(
          SUM(vlx_amount),
          0
        ) AS reserved
      FROM presale_orders
      WHERE
        status='PENDING'
        AND created_at >= $1
      `,
      [
        now() -
          PRESALE_ORDER_TTL,
      ]
    );

  return Number(
    result.rows[0]?.reserved || 0
  );
}

function validTon(wallet) {
  if (
    typeof wallet !==
    "string"
  ) {
    return false;
  }

  wallet = wallet.trim();

  return (
    /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46,48}$/.test(
      wallet
    ) ||
    /^(0|-1):[0-9a-fA-F]{64}$/.test(
      wallet
    )
  );
}

function nanoTon(amount) {
  return Math.round(
    Number(amount) *
      1e9
  );
}

/* =========================
   PRESALE CONFIG
========================= */

app.get(
  "/api/presale/config",
  async (req, res) => {
    try {
      await expireOrders();

      const soldAmount =
        await sold();

      const reservedAmount =
        await reserved();

      res.json({
        ok: true,

        active:
          soldAmount +
            reservedAmount <
          PRESALE_ALLOCATION,

        rate:
          PRESALE_RATE,

        allocation:
          PRESALE_ALLOCATION,

        sold:
          soldAmount,

        reserved:
          reservedAmount,

        remaining:
          Math.max(
            0,
            PRESALE_ALLOCATION -
              soldAmount -
              reservedAmount
          ),

        tonAddress:
          PRESALE_TON_ADDRESS,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   CREATE PRESALE ORDER
========================= */

app.post(
  "/api/presale/create-order",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const ton =
        Number(
          req.body.tonAmount
        );

      const wallet =
        String(
          req.body.wallet || ""
        ).trim();

      if (
        !Number.isFinite(
          ton
        ) ||
        ton < 0.01
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Minimum presale amount is 0.01 TON",
        });
      }

      if (!validTon(wallet)) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid TON wallet address",
        });
      }

      await expireOrders();

      const soldAmount =
        await sold();

      const reservedAmount =
        await reserved();

      const vlx =
        ton * PRESALE_RATE;

      if (
        soldAmount +
          reservedAmount +
          vlx >
        PRESALE_ALLOCATION
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Not enough VLX allocation remaining",
        });
      }

      await client.query(
        "BEGIN"
      );

      const result =
        await client.query(
          `
          INSERT INTO presale_orders
          (
            user_id,
            ton_amount,
            vlx_amount,
            wallet,
            tx_hash,
            status,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            NULL,
            'PENDING',
            $5
          )
          RETURNING *
          `,
          [
            Number(
              req.tgUser.id
            ),
            ton,
            vlx,
            wallet,
            now(),
          ]
        );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,

        order: {
          id: Number(
            result.rows[0].id
          ),
          ton_amount: ton,
          vlx_amount: vlx,
          wallet,
          status: "PENDING",
        },

        destination:
          PRESALE_TON_ADDRESS,
      });
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   TON CENTER
========================= */

async function tonMessages(
  params
) {
  const url = new URL(
    "https://toncenter.com/api/v3/messages"
  );

  for (
    const [key, value] of Object.entries(
      params
    )
  ) {
    if (
      value !== undefined &&
      value !== null
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const headers = {};

  if (TONCENTER_API_KEY) {
    headers["X-API-Key"] =
      TONCENTER_API_KEY;
  }

  const response =
    await fetch(url, {
      headers,
    });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error ||
        "TON Center request failed"
    );
  }

  return data;
}

/* =========================
   FIND TON PAYMENT
========================= */

async function findPayment(order) {
  const data =
    await tonMessages({
      source:
        order.wallet,

      destination:
        PRESALE_TON_ADDRESS,

      start_utime:
        Number(
          order.created_at
        ) - 120,

      direction: "in",

      limit: 50,

      sort: "desc",
    });

  const messages =
    Array.isArray(
      data?.messages
    )
      ? data.messages
      : [];

  const expected =
    nanoTon(
      order.ton_amount
    );

  return messages.find(
    (message) =>
      Number(
        message.value || 0
      ) === expected &&
      !message.bounced &&
      (
        message.hash ||
        message.message_hash
      )
  ) || null;
}

/* =========================
   VERIFY PRESALE ORDER
========================= */

async function verifyOrder(
  orderId
) {
  const client =
    await pool.connect();

  try {
    const result =
      await client.query(
        `
        SELECT *
        FROM presale_orders
        WHERE id=$1
        `,
        [orderId]
      );

    if (!result.rows.length) {
      return null;
    }

    let order =
      result.rows[0];

    if (
      order.status ===
        "APPROVED" ||
      order.status ===
        "EXPIRED" ||
      order.status ===
        "REJECTED"
    ) {
      return order;
    }

    if (
      Number(
        order.created_at
      ) <
      now() -
        PRESALE_ORDER_TTL
    ) {
      await db(
        `
        UPDATE presale_orders
        SET status='EXPIRED'
        WHERE id=$1
        `,
        [orderId]
      );

      order.status =
        "EXPIRED";

      return order;
    }

    const payment =
      await findPayment(
        order
      );

    if (!payment) {
      return order;
    }

    const hash =
      payment.hash ||
      payment.message_hash;

    const duplicate =
      await db(
        `
        SELECT id
        FROM presale_orders
        WHERE
          tx_hash=$1
          AND id<>$2
        `,
        [
          hash,
          orderId,
        ]
      );

    if (duplicate.rows.length) {
      await db(
        `
        UPDATE presale_orders
        SET status='REJECTED'
        WHERE id=$1
        `,
        [orderId]
      );

      order.status =
        "REJECTED";

      return order;
    }

    await client.query(
      "BEGIN"
    );

    const updated =
      await client.query(
        `
        UPDATE presale_orders
        SET
          status='APPROVED',
          tx_hash=$1,
          verified_at=$2
        WHERE id=$3
        RETURNING *
        `,
        [
          hash,
          now(),
          orderId,
        ]
      );

    await client.query(
      `
      UPDATE users
      SET
        presale_balance =
          COALESCE(
            presale_balance,
            0
          ) + $1
      WHERE id=$2
      `,
      [
        Number(
          order.vlx_amount
        ),
        Number(
          order.user_id
        ),
      ]
    );

    await client.query(
      "COMMIT"
    );

    return updated.rows[0];
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    console.error(
      "Presale verification:",
      error.message
    );

    return null;
  } finally {
    client.release();
  }
}

/* =========================
   USER PRESALE ORDER
========================= */

app.get(
  "/api/presale/order/:id",
  auth,
  async (req, res) => {
    try {
      const orderId =
        Number(
          req.params.id
        );

      const own =
        await db(
          `
          SELECT *
          FROM presale_orders
          WHERE
            id=$1
            AND user_id=$2
          `,
          [
            orderId,
            Number(
              req.tgUser.id
            ),
          ]
        );

      if (!own.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Order not found",
        });
      }

      const order =
        await verifyOrder(
          orderId
        );

      if (!order) {
        return res.status(404).json({
          ok: false,
          error:
            "Order not found",
        });
      }

      res.json({
        ok: true,

        status:
          order.status,

        order: {
          id: Number(
            order.id
          ),

          ton_amount:
            Number(
              order.ton_amount
            ),

          vlx_amount:
            Number(
              order.vlx_amount
            ),

          wallet:
            order.wallet,

          tx_hash:
            order.tx_hash,

          status:
            order.status,

          created_at:
            Number(
              order.created_at
            ),

          verified_at:
            order.verified_at
              ? Number(
                  order.verified_at
                )
              : null,
        },
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   USER PRESALE ORDERS
========================= */

app.get(
  "/api/presale/orders",
  auth,
  async (req, res) => {
    try {
      await expireOrders();

      const result =
        await db(
          `
          SELECT *
          FROM presale_orders
          WHERE user_id=$1
          ORDER BY id DESC
          LIMIT 50
          `,
          [
            Number(
              req.tgUser.id
            ),
          ]
        );

      res.json({
        ok: true,
        orders:
          result.rows,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   ADMIN TASKS
========================= */

app.get(
  "/api/admin/tasks",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `
          SELECT *
          FROM tasks
          WHERE type='telegram'
          ORDER BY id DESC
          `
        );

      res.json({
        ok: true,
        tasks:
          result.rows,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   CREATE TELEGRAM TASK
========================= */

app.post(
  "/api/admin/tasks",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `
          INSERT INTO tasks
          (
            title,
            description,
            reward,
            type,
            target,
            target_id,
            active,
            created_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            'telegram',
            $4,
            $5,
            TRUE,
            $6
          )
          RETURNING *
          `,
          [
            req.body.title,
            req.body.description ||
              "",
            Number(
              req.body.reward || 0
            ),
            req.body.target ||
              "",
            req.body.targetId ||
              null,
            now(),
          ]
        );

      res.json({
        ok: true,
        task:
          result.rows[0],
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   TOGGLE TASK
========================= */

app.post(
  "/api/admin/tasks/:id/toggle",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `
          UPDATE tasks
          SET active=NOT active
          WHERE
            id=$1
            AND type='telegram'
          RETURNING *
          `,
          [
            Number(
              req.params.id
            ),
          ]
        );

      res.json({
        ok: true,
        task:
          result.rows[0],
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   DELETE TASK
========================= */

app.delete(
  "/api/admin/tasks/:id",
  adminAuth,
  async (req, res) => {
    try {
      const taskId =
        Number(
          req.params.id
        );

      await db(
        `
        DELETE FROM task_claims
        WHERE task_id=$1
        `,
        [taskId]
      );

      await db(
        `
        DELETE FROM tasks
        WHERE
          id=$1
          AND type='telegram'
        `,
        [taskId]
      );

      res.json({
        ok: true,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
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
      const result =
        await db(
          `
          SELECT
            w.*,
            u.username,
            u.first_name
          FROM withdrawals w
          LEFT JOIN users u
            ON u.id=w.user_id
          ORDER BY w.id DESC
          LIMIT 200
          `
        );

      res.json({
        ok: true,
        withdrawals:
          result.rows,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   ADMIN WITHDRAWAL STATUS
========================= */

app.post(
  "/api/admin/withdrawals/:id",
  adminAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const id =
        Number(
          req.params.id
        );

      const status =
        String(
          req.body.status || ""
        ).toUpperCase();

      if (
        ![
          "APPROVED",
          "REJECTED",
          "PENDING",
        ].includes(status)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid status",
        });
      }

      await client.query(
        "BEGIN"
      );

      const result =
        await client.query(
          `
          SELECT *
          FROM withdrawals
          WHERE id=$1
          FOR UPDATE
          `,
          [id]
        );

      if (!result.rows.length) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          ok: false,
          error:
            "Withdrawal not found",
        });
      }

      const withdrawal =
        result.rows[0];

      if (
        withdrawal.status ===
          "PENDING" &&
        status ===
          "REJECTED"
      ) {
        await client.query(
          `
          UPDATE users
          SET balance=balance+$1
          WHERE id=$2
          `,
          [
            Number(
              withdrawal.amount
            ),
            Number(
              withdrawal.user_id
            ),
          ]
        );
      }

      await client.query(
        `
        UPDATE withdrawals
        SET
          status=$1,

          processed_at=
            CASE
              WHEN $1 IN
                ('APPROVED','REJECTED')
              THEN $2
              ELSE processed_at
            END,

          tx_hash=
            COALESCE(
              $3,
              tx_hash
            )

        WHERE id=$4
        `,
        [
          status,
          now(),
          req.body.txHash ||
            null,
          id,
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
      });
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error:
          "Withdrawal update failed",
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   ADMIN PRESALE ORDERS
========================= */

app.get(
  "/api/admin/presale/orders",
  adminAuth,
  async (req, res) => {
    try {
      await expireOrders();

      const result =
        await db(
          `
          SELECT
            p.*,
            u.username,
            u.first_name
          FROM presale_orders p
          LEFT JOIN users u
            ON u.id=p.user_id
          ORDER BY p.id DESC
          LIMIT 500
          `
        );

      res.json({
        ok: true,
        orders:
          result.rows,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   ADMIN PRESALE STATUS
========================= */

app.get(
  "/api/admin/presale/status",
  adminAuth,
  async (req, res) => {
    try {
      await expireOrders();

      const soldAmount =
        await sold();

      const reservedAmount =
        await reserved();

      res.json({
        ok: true,

        rate:
          PRESALE_RATE,

        allocation:
          PRESALE_ALLOCATION,

        sold:
          soldAmount,

        reserved:
          reservedAmount,

        remaining:
          Math.max(
            0,
            PRESALE_ALLOCATION -
              soldAmount -
              reservedAmount
          ),

        tonAddress:
          PRESALE_TON_ADDRESS,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
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
      const users =
        await db(
          `
          SELECT COUNT(*)::int AS count
          FROM users
          `
        );

      const balance =
        await db(
          `
          SELECT
            COALESCE(
              SUM(balance),
              0
            ) AS total
          FROM users
          `
        );

      const pending =
        await db(
          `
          SELECT COUNT(*)::int AS count
          FROM withdrawals
          WHERE status='PENDING'
          `
        );

      res.json({
        ok: true,

        users:
          Number(
            users.rows[0].count
          ),

        totalBalance:
          Number(
            balance.rows[0].total
          ),

        pendingWithdrawals:
          Number(
            pending.rows[0].count
          ),

        presaleSold:
          await sold(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

/* =========================
   MINING NOTIFICATIONS
========================= */

async function miningNotifications() {
  if (!bot) {
    return;
  }

  try {
    const result = await db(`
      SELECT *
      FROM users
      WHERE
        cycle_start IS NOT NULL
        AND cycle_start + ${CYCLE_SECONDS} <= ${now()}
        AND COALESCE(mining_notified_cycle, 0) != cycle_start
      LIMIT 500
    `);

    for (const user of result.rows) {
      const cycle = Number(user.cycle_start);

      try {
        await bot.telegram.sendMessage(
          Number(user.id),
          `⛏️ VELTRIX Mining Complete!

🎉 Your ${CYCLE_HOURS}-hour mining cycle is complete.

💰 Reward: ${(RATE * CYCLE_HOURS).toFixed(2)} VLX

👇 Claim your VLX now.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⛏️ Claim VLX",
                    web_app: {
                      url: APP_URL
                    }
                  }
                ]
              ]
            }
          }
        );

        await db(
          `
          UPDATE users
          SET mining_notified_cycle = $1
          WHERE id = $2
          `,
          [
            cycle,
            Number(user.id)
          ]
        );

      } catch (sendError) {
        console.error(
          `Mining notification failed for user ${user.id}:`,
          sendError.message
        );
      }
    }

  } catch (error) {
    console.error(
      "Mining notification checker error:",
      error.message
    );
  }
}


/* =========================
   TELEGRAM BOT
========================= */

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await createUser(
        ctx.from,
        ctx.startPayload || null
      );

      await ctx.reply(
        `⛏️ VELTRIX — VLX Miner

💎 Rate: ${RATE} VLX/hour
⏱️ Cycle: ${CYCLE_HOURS} hours

Welcome to VELTRIX 👑`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⛏️ Mine VLX",
                  web_app: {
                    url: `${APP_URL}?ref=${ctx.from.id}`
                  }
                },
                {
                  text: "💎 VLX Presale",
                  web_app: {
                    url: `${APP_URL}?section=presale&ref=${ctx.from.id}`
                  }
                }
              ]
            ]
          }
        }
      );

    } catch (error) {
      console.error(
        "Telegram /start error:",
        error.message
      );

      await ctx.reply(
        "VELTRIX is temporarily unavailable. Please try again."
      );
    }
  });

  bot.catch((error) => {
    console.error(
      "Telegram bot error:",
      error.message
    );
  });
}


/* =========================
   SERVER START
========================= */

async function start() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `VELTRIX running on port ${PORT}`
        );
      }
    );

    setInterval(
      miningNotifications,
      60 * 1000
    );

    if (bot) {
      bot.launch()
        .then(() => {
          console.log(
            "VELTRIX Telegram bot started"
          );
        })
        .catch((error) => {
          console.error(
            "Bot launch error:",
            error.message
          );
        });
    } else {
      console.error(
        "BOT_TOKEN is missing"
      );
    }

  } catch (error) {
    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);
  }
}

start();


/* =========================
   GRACEFUL SHUTDOWN
========================= */

process.once(
  "SIGINT",
  () => {
    if (bot) {
      bot.stop("SIGINT");
    }

    pool.end();
  }
);

process.once(
  "SIGTERM",
  () => {
    if (bot) {
      bot.stop("SIGTERM");
    }

    pool.end();
  }
);
