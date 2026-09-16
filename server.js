import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import crypto from "crypto";
import { Telegraf } from "telegraf";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || "";

const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

// =========================
// VELTRIX SETTINGS
// =========================
const RATE = 4.74;                 // VLX per hour
const CYCLE_HOURS = 8;
const CYCLE_SECONDS = CYCLE_HOURS * 60 * 60;

const REFERRAL_BONUS = 300;
const MIN_WITHDRAW = 10000;

// =========================
// DATABASE
// =========================
const db = new Database("veltrix.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance REAL DEFAULT 0,
  wallet TEXT DEFAULT '',
  referrer_id INTEGER,
  cycle_start INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  reward REAL DEFAULT 0,
  channel TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  UNIQUE(user_id, task_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  created_at INTEGER NOT NULL
);
`);

// =========================
// SAFE MIGRATION
// =========================
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some(c => c.name === column);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "wallet", "TEXT DEFAULT ''");
ensureColumn("users", "referrer_id", "INTEGER");
ensureColumn("users", "cycle_start", "INTEGER");
ensureColumn("users", "created_at", "INTEGER");

ensureColumn("tasks", "channel", "TEXT DEFAULT ''");
ensureColumn("tasks", "active", "INTEGER DEFAULT 1");

// Fix old users which may have no cycle_start
db.prepare(`
  UPDATE users
  SET cycle_start = ?
  WHERE cycle_start IS NULL OR cycle_start <= 0
`).run(Math.floor(Date.now() / 1000));

// =========================
// TELEGRAM
// =========================
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing.");
}

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// =========================
// HELPERS
// =========================
function now() {
  return Math.floor(Date.now() / 1000);
}

function calculateMining(user) {
  const start = Number(user.cycle_start || now());
  const elapsed = Math.max(0, Math.min(now() - start, CYCLE_SECONDS));

  return (elapsed / 3600) * RATE;
}

function cycleRemaining(user) {
  const start = Number(user.cycle_start || now());
  return Math.max(0, CYCLE_SECONDS - (now() - start));
}

function canClaim(user) {
  return cycleRemaining(user) <= 0;
}

function publicUser(user) {
  const mining = calculateMining(user);
  const total = Number(user.balance || 0) + mining;

  return {
    id: user.id,
    username: user.username || "",
    first_name: user.first_name || "",
    balance: Number(user.balance || 0),
    currentMining: mining,
    totalBalance: total,
    rate: RATE,
    cycleHours: CYCLE_HOURS,
    cycleRemaining: cycleRemaining(user),
    canClaim: canClaim(user),
    wallet: user.wallet || ""
  };
}

// =========================
// TELEGRAM INIT DATA VERIFY
// =========================
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

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

    const authDate = Number(params.get("auth_date") || 0);

    // Do not accept very old Telegram sessions
    if (!authDate || now() - authDate > 86400) {
      return null;
    }

    const user = JSON.parse(params.get("user") || "{}");

    if (!user.id) return null;

    return user;
  } catch {
    return null;
  }
}

// =========================
// AUTH MIDDLEWARE
// =========================
function requireTelegram(req, res, next) {
  const initData =
    req.headers["x-telegram-init-data"] ||
    req.body?.initData ||
    req.query?.initData;

  const tgUser = verifyTelegramInitData(initData);

  if (!tgUser) {
    return res.status(401).json({
      ok: false,
      error: "Telegram authentication failed"
    });
  }

  req.tgUser = tgUser;
  next();
}

function requireAdmin(req, res, next) {
  const tgUser = verifyTelegramInitData(
    req.headers["x-telegram-init-data"] ||
    req.body?.initData
  );

  if (!tgUser || Number(tgUser.id) !== ADMIN_ID) {
    return res.status(403).json({
      ok: false,
      error: "Admin only"
    });
  }

  req.tgUser = tgUser;
  next();
}

// =========================
// USER
// =========================
function getUser(id) {
  return db.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).get(id);
}

function createUser(tgUser, refId = null) {
  const existing = getUser(tgUser.id);

  if (existing) {
    db.prepare(`
      UPDATE users
      SET username = ?, first_name = ?
      WHERE id = ?
    `).run(
      tgUser.username || "",
      tgUser.first_name || "",
      tgUser.id
    );

    return getUser(tgUser.id);
  }

  let referrer = null;

  if (refId) {
    const numericRef = Number(refId);

    if (
      Number.isInteger(numericRef) &&
      numericRef !== Number(tgUser.id)
    ) {
      referrer = getUser(numericRef);
    }
  }

  const timestamp = now();

  db.prepare(`
    INSERT INTO users
    (id, username, first_name, balance, wallet, referrer_id, cycle_start, created_at)
    VALUES (?, ?, ?, 0, '', ?, ?, ?)
  `).run(
    tgUser.id,
    tgUser.username || "",
    tgUser.first_name || "",
    referrer ? referrer.id : null,
    timestamp,
    timestamp
  );

  // Referral reward only once, when a NEW user is created
  if (referrer) {
    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(REFERRAL_BONUS, referrer.id);
  }

  return getUser(tgUser.id);
}

// =========================
// START
// =========================
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/web/index.html");
});

app.use("/web", express.static(process.cwd() + "/web"));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    project: "VELTRIX",
    symbol: "VLX",
    rate: RATE,
    cycleHours: CYCLE_HOURS
  });
});

// =========================
// USER API
// =========================
app.post("/api/user", requireTelegram, (req, res) => {
  const ref =
    req.body?.ref ||
    req.query?.ref ||
    "";

  const user = createUser(req.tgUser, ref);

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

// =========================
// MINING
// =========================
app.get("/api/mining", requireTelegram, (req, res) => {
  const user = getUser(req.tgUser.id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found"
    });
  }

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

// =========================
// CLAIM MINING
// =========================
app.post("/api/claim", requireTelegram, (req, res) => {
  const user = getUser(req.tgUser.id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found"
    });
  }

  const reward = calculateMining(user);

  if (!canClaim(user)) {
    return res.status(400).json({
      ok: false,
      error: "Mining cycle is not finished yet",
      user: publicUser(user)
    });
  }

  if (reward <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Nothing to claim"
    });
  }

  db.prepare(`
    UPDATE users
    SET balance = balance + ?,
        cycle_start = ?
    WHERE id = ?
  `).run(
    reward,
    now(),
    user.id
  );

  const updated = getUser(user.id);

  res.json({
    ok: true,
    reward,
    user: publicUser(updated)
  });
});

// =========================
// TASKS
// =========================
app.get("/api/tasks", requireTelegram, (req, res) => {
  const tasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.url,
      t.reward,
      t.channel,
      t.active,
      CASE
        WHEN tc.id IS NULL THEN 0
        ELSE 1
      END AS claimed
    FROM tasks t
    LEFT JOIN task_claims tc
      ON tc.task_id = t.id
      AND tc.user_id = ?
    WHERE t.active = 1
    ORDER BY t.id DESC
  `).all(req.tgUser.id);

  res.json({
    ok: true,
    tasks
  });
});

// =========================
// TELEGRAM CHANNEL VERIFY
// =========================
async function verifyChannelMember(channel, userId) {
  if (!bot) return false;

  if (!channel) return false;

  try {
    const member = await bot.telegram.getChatMember(
      channel,
      userId
    );

    if (!member) return false;

    if (
      member.status === "creator" ||
      member.status === "administrator" ||
      member.status === "member"
    ) {
      return true;
    }

    if (
      member.status === "restricted" &&
      member.is_member === true
    ) {
      return true;
    }

    return false;
  } catch (error) {
    console.error(
      "Channel verification error:",
      error?.description || error?.message || error
    );

    return false;
  }
}

// =========================
// CLAIM TASK
// =========================
app.post("/api/task/claim", requireTelegram, async (req, res) => {
  const taskId = Number(req.body?.taskId);

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task"
    });
  }

  const task = db.prepare(`
    SELECT * FROM tasks
    WHERE id = ? AND active = 1
  `).get(taskId);

  if (!task) {
    return res.status(404).json({
      ok: false,
      error: "Task not found"
    });
  }

  const already = db.prepare(`
    SELECT id
    FROM task_claims
    WHERE user_id = ? AND task_id = ?
  `).get(req.tgUser.id, taskId);

  if (already) {
    return res.status(400).json({
      ok: false,
      error: "You already claimed this task"
    });
  }

  // Real channel verification
  if (task.channel) {
    const joined = await verifyChannelMember(
      task.channel,
      req.tgUser.id
    );

    if (!joined) {
      return res.status(400).json({
        ok: false,
        error:
          "Please join the Telegram channel first, then press VERIFY again."
      });
    }
  }

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO task_claims
      (user_id, task_id, claimed_at)
      VALUES (?, ?, ?)
    `).run(
      req.tgUser.id,
      taskId,
      now()
    );

    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(
      Number(task.reward || 0),
      req.tgUser.id
    );
  });

  try {
    transaction();

    const updated = getUser(req.tgUser.id);

    res.json({
      ok: true,
      reward: Number(task.reward || 0),
      user: publicUser(updated)
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      ok: false,
      error: "Task already claimed or database error"
    });
  }
});

// =========================
// FRIENDS
// =========================
app.get("/api/referral", requireTelegram, (req, res) => {
  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE referrer_id = ?
  `).get(req.tgUser.id);

  const referralLink =
    `https://t.me/VeltrixMinerBot?start=${req.tgUser.id}`;

  res.json({
    ok: true,
    referralLink,
    referralBonus: REFERRAL_BONUS,
    referrals: Number(count.count || 0)
  });
});

// =========================
// LEADERBOARD
// =========================
app.get("/api/leaderboard", requireTelegram, (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      username,
      first_name,
      balance
    FROM users
    ORDER BY balance DESC
    LIMIT 20
  `).all();

  res.json({
    ok: true,
    leaderboard: rows.map((u, index) => ({
      rank: index + 1,
      id: u.id,
      username: u.username || "",
      first_name: u.first_name || "User",
      balance: Number(u.balance || 0)
    }))
  });
});

// =========================
// WALLET
// =========================
function validWallet(wallet) {
  return /^0x[a-fA-F0-9]{40}$/.test(wallet);
}

app.post("/api/wallet", requireTelegram, (req, res) => {
  const wallet = String(req.body?.wallet || "").trim();

  if (!validWallet(wallet)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid EVM wallet address"
    });
  }

  db.prepare(`
    UPDATE users
    SET wallet = ?
    WHERE id = ?
  `).run(
    wallet,
    req.tgUser.id
  );

  const user = getUser(req.tgUser.id);

  res.json({
    ok: true,
    wallet: user.wallet
  });
});

// =========================
// WITHDRAW
// =========================
app.post("/api/withdraw", requireTelegram, (req, res) => {
  const amount = Number(req.body?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Invalid amount"
    });
  }

  const user = getUser(req.tgUser.id);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found"
    });
  }

  if (!user.wallet || !validWallet(user.wallet)) {
    return res.status(400).json({
      ok: false,
      error: "Please save your wallet first"
    });
  }

  if (amount < MIN_WITHDRAW) {
    return res.status(400).json({
      ok: false,
      error: `Minimum withdrawal is ${MIN_WITHDRAW} VLX`
    });
  }

  // Only CLAIMED balance can be withdrawn.
  // Current 8-hour mining reward must be claimed first.
  const balance = Number(user.balance || 0);

  if (amount > balance) {
    return res.status(400).json({
      ok: false,
      error: "Insufficient claimed VLX balance"
    });
  }

  const pending = db.prepare(`
    SELECT id
    FROM withdrawals
    WHERE user_id = ?
      AND status = 'PENDING'
    LIMIT 1
  `).get(user.id);

  if (pending) {
    return res.status(400).json({
      ok: false,
      error: "You already have a pending withdrawal"
    });
  }

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET balance = balance - ?
      WHERE id = ?
    `).run(amount, user.id);

    db.prepare(`
      INSERT INTO withdrawals
      (user_id, amount, wallet, status, created_at)
      VALUES (?, ?, ?, 'PENDING', ?)
    `).run(
      user.id,
      amount,
      user.wallet,
      now()
    );
  });

  transaction();

  res.json({
    ok: true,
    status: "PENDING",
    amount,
    message:
      "Withdrawal submitted. It will remain PENDING until VLX distribution is activated."
  });
});

// =========================
// ADMIN - ADD TASK
// =========================
app.post("/api/admin/task", requireAdmin, (req, res) => {
  const title = String(req.body?.title || "").trim();
  const url = String(req.body?.url || "").trim();
  const channel = String(req.body?.channel || "").trim();
  const reward = Number(req.body?.reward || 0);

  if (!title || !url || !channel || reward <= 0) {
    return res.status(400).json({
      ok: false,
      error:
        "title, url, channel and reward are required"
    });
  }

  const result = db.prepare(`
    INSERT INTO tasks
    (title, url, reward, channel, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    title,
    url,
    reward,
    channel,
    now()
  );

  res.json({
    ok: true,
    taskId: result.lastInsertRowid
  });
});

// =========================
// ADMIN - TASK LIST
// =========================
app.get("/api/admin/tasks", requireAdmin, (req, res) => {
  const tasks = db.prepare(`
    SELECT *
    FROM tasks
    ORDER BY id DESC
  `).all();

  res.json({
    ok: true,
    tasks
  });
});

// =========================
// ADMIN - TOGGLE TASK
// =========================
app.post("/api/admin/task/toggle", requireAdmin, (req, res) => {
  const taskId = Number(req.body?.taskId);

  const task = db.prepare(`
    SELECT *
    FROM tasks
    WHERE id = ?
  `).get(taskId);

  if (!task) {
    return res.status(404).json({
      ok: false,
      error: "Task not found"
    });
  }

  db.prepare(`
    UPDATE tasks
    SET active = ?
    WHERE id = ?
  `).run(
    task.active ? 0 : 1,
    taskId
  );

  res.json({
    ok: true
  });
});

// =========================
// ADMIN - WITHDRAWALS
// =========================
app.get("/api/admin/withdrawals", requireAdmin, (req, res) => {
  const withdrawals = db.prepare(`
    SELECT
      w.*,
      u.username,
      u.first_name
    FROM withdrawals w
    LEFT JOIN users u
      ON u.id = w.user_id
    ORDER BY w.id DESC
  `).all();

  res.json({
    ok: true,
    withdrawals
  });
});

// =========================
// ADMIN STATUS
// =========================
app.get("/api/admin/status", requireAdmin, (req, res) => {
  const users = db.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).get();

  const tasks = db.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE active = 1"
  ).get();

  const withdrawals = db.prepare(`
    SELECT COUNT(*) AS count
    FROM withdrawals
    WHERE status = 'PENDING'
  `).get();

  res.json({
    ok: true,
    users: Number(users.count || 0),
    activeTasks: Number(tasks.count || 0),
    pendingWithdrawals: Number(withdrawals.count || 0),
    rate: RATE,
    cycleHours: CYCLE_HOURS,
    referralBonus: REFERRAL_BONUS,
    minimumWithdraw: MIN_WITHDRAW
  });
});

// =========================
// BOT
// =========================
if (bot) {
  bot.start(async (ctx) => {
    const refId = ctx.startPayload || "";

    const message =
      `⚡ VELTRIX (VLX)\n\n` +
      `⛏️ Mine VLX Points and invite friends!\n\n` +
      `⏱️ Mining: ${RATE} VLX/hour\n` +
      `🔄 Cycle: ${CYCLE_HOURS} hours\n` +
      `👥 Referral Bonus: ${REFERRAL_BONUS} VLX\n` +
      `💸 Minimum Withdraw: ${MIN_WITHDRAW} VLX\n\n` +
      `⚠️ VLX Points are currently off-chain.\n` +
      `Future token distribution and listing will be announced by the project.`;

    const webAppUrl = refId
      ? `${APP_URL}?ref=${encodeURIComponent(refId)}`
      : APP_URL;

    if (APP_URL) {
      await ctx.reply(message, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⛏️ OPEN VELTRIX MINER",
                web_app: {
                  url: webAppUrl
                }
              }
            ]
          ]
        }
      });
    } else {
      await ctx.reply(message);
    }
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`Your Telegram ID: ${ctx.from.id}`);
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  bot.launch()
    .then(() => console.log("VELTRIX Telegram bot started"))
    .catch(err => console.error("Bot launch error:", err));

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

// =========================
// SERVER
// =========================
app.listen(PORT, () => {
  console.log(`VELTRIX server running on port ${PORT}`);
});
