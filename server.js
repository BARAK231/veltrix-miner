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
const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;

const X_CALLBACK_URL =
  `${APP_URL}/api/x/callback`;

const X_OFFICIAL_USERNAME = "VeltrixExchang";
const X_REPOST_POST_ID = "2101180648618959312";

const X_FOLLOW_REWARD = 50;
const X_REPOST_REWARD = 35;
/* =========================
   X OAUTH 2.0
========================= */

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createPKCE() {
  const verifier = base64Url(
    crypto.randomBytes(32)
  );

  const challenge = base64Url(
    crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
  );

  return {
    verifier,
    challenge
  };
}

/* Start X login */
app.get("/api/x/auth", auth, async (req, res) => {
  try {
    if (!X_CLIENT_ID) {
      return res.status(500).send("X_CLIENT_ID is missing");
    }

    const { verifier, challenge } = createPKCE();

    const state = base64Url(
      crypto.randomBytes(32)
    );

    const expiresAt = now() + 600;

    await db(
      `
      INSERT INTO x_oauth_states
        (state, user_id, code_verifier, expires_at)
      VALUES
        ($1, $2, $3, $4)
      `,
      [
        state,
        req.tgUser.id,
        verifier,
        expiresAt
      ]
    );

    const params = new URLSearchParams({
      response_type: "code",
      client_id: X_CLIENT_ID,
      redirect_uri: X_CALLBACK_URL,
      scope: "tweet.read users.read follows.read offline.access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

    const url =
      `https://x.com/i/oauth2/authorize?${params.toString()}`;

    res.redirect(url);

  } catch (err) {
    console.error("X OAuth start error:", err);

    res.status(500).send(
      "X authentication could not be started"
    );
  }
});

/* X callback */
app.get("/api/x/callback", async (req, res) => {
  try {
    const {
      code,
      state,
      error
    } = req.query;

    if (error) {
      return res.status(400).send(
        `X authorization failed: ${error}`
      );
    }

    if (!code || !state) {
      return res.status(400).send(
        "Invalid X OAuth response"
      );
    }

    const stateResult = await db(
      `
      SELECT *
      FROM x_oauth_states
      WHERE state = $1
        AND expires_at > $2
      `,
      [
        state,
        now()
      ]
    );

    const oauthState = stateResult.rows[0];

    if (!oauthState) {
      return res.status(400).send(
        "Invalid or expired OAuth state"
      );
    }

    await db(
      `
      DELETE FROM x_oauth_states
      WHERE state = $1
      `,
      [state]
    );

    const basicAuth = Buffer
      .from(
        `${X_CLIENT_ID}:${X_CLIENT_SECRET}`
      )
      .toString("base64");

    const tokenResponse = await fetch(
      "https://api.x.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "Authorization":
            `Basic ${basicAuth}`
        },
        body: new URLSearchParams({
          code: String(code),
          grant_type: "authorization_code",
          client_id: X_CLIENT_ID,
          redirect_uri: X_CALLBACK_URL,
          code_verifier:
            oauthState.code_verifier
        })
      }
    );

    const tokenData =
      await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error(
        "X token error:",
        tokenData
      );

      return res.status(400).send(
        "X token exchange failed"
      );
    }

    const meResponse = await fetch(
      "https://api.x.com/2/users/me?user.fields=username",
      {
        headers: {
          Authorization:
            `Bearer ${tokenData.access_token}`
        }
      }
    );

    const meData =
      await meResponse.json();

    if (!meResponse.ok || !meData.data) {
      console.error(
        "X user error:",
        meData
      );

      return res.status(400).send(
        "Could not get X account"
      );
    }

    const expiresAt =
      now() +
      Number(tokenData.expires_in || 7200);

    await db(
      `
      INSERT INTO x_accounts
        (
          user_id,
          x_user_id,
          x_username,
          access_token,
          refresh_token,
          expires_at,
          scope,
          created_at,
          updated_at
        )
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      ON CONFLICT (user_id)
      DO UPDATE SET
        x_user_id = EXCLUDED.x_user_id,
        x_username = EXCLUDED.x_username,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        updated_at = EXCLUDED.updated_at
      `,
      [
        oauthState.user_id,
        meData.data.id,
        meData.data.username || "",
        tokenData.access_token,
        tokenData.refresh_token || null,
        expiresAt,
        tokenData.scope || "",
        now()
      ]
    );

    res.redirect(
      `${APP_URL}?x_connected=1`
    );

  } catch (err) {
    console.error(
      "X OAuth callback error:",
      err
    );

    res.status(500).send(
      "X authentication failed"
    );
  }
});

/* X connection status */
app.get("/api/x/status", auth, async (req, res) => {
  try {
    const result = await db(
      `
      SELECT
        x_user_id,
        x_username,
        expires_at
      FROM x_accounts
      WHERE user_id = $1
      `,
      [req.tgUser.id]
    );

    if (!result.rows.length) {
      return res.json({
        connected: false
      });
    }

    const account = result.rows[0];

    res.json({
      connected: true,
      x_user_id: account.x_user_id,
      x_username: account.x_username || "",
      expires_at: Number(
        account.expires_at || 0
      )
    });

  } catch (err) {
    console.error(
      "X status error:",
      err
    );

    res.status(500).json({
      error: "X status failed"
    });
  }
});
 /* =========================
    X TASK VERIFICATION
 ========================= */

async function getXAccount(userId) {
  const result = await db(
    `
    SELECT *
    FROM x_accounts
    WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getXOfficialUserId(accessToken) {
  const response = await fetch(
    `https://api.x.com/2/users/by/username/${X_OFFICIAL_USERNAME}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.data) {
    throw new Error(
      data.detail || "Could not find VELTRIX X account"
    );
  }

  return data.data.id;
}

/* Check Follow */
async function verifyXFollow(accessToken, xUserId) {
  const officialId =
    await getXOfficialUserId(accessToken);

  let paginationToken = null;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      max_results: "1000",
      "user.fields": "id,username"
    });

    if (paginationToken) {
      params.set(
        "pagination_token",
        paginationToken
      );
    }

    const response = await fetch(
      `https://api.x.com/2/users/${xUserId}/following?${params.toString()}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.detail || "X Follow verification failed"
      );
    }

    const following = data.data || [];

    const found = following.some(
      user => String(user.id) === String(officialId)
    );

    if (found) return true;

    paginationToken =
      data.meta?.next_token || null;

    if (!paginationToken) break;
  }

  return false;
}

/* Check Repost */
async function verifyXRepost(accessToken, xUserId) {
  const params = new URLSearchParams({
    max_results: "100",
    "user.fields": "id,username"
  });

  const response = await fetch(
    `https://api.x.com/2/tweets/${X_REPOST_POST_ID}/retweeted_by?${params.toString()}`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.detail || "X Repost verification failed"
    );
  }

  const users = data.data || [];

  return users.some(
    user => String(user.id) === String(xUserId)
  );
}

/* Verify X task */
app.post(
  "/api/x/verify-task",
  auth,
  async (req, res) => {
    try {
      const taskId =
        Number(req.body.taskId);

      if (!taskId) {
        return res.status(400).json({
          error: "Invalid task"
        });
      }

      const taskResult = await db(
        `
        SELECT *
        FROM tasks
        WHERE id = $1
          AND active = true
          AND type IN ('x_follow', 'x_repost')
        `,
        [taskId]
      );

      const task = taskResult.rows[0];

      if (!task) {
        return res.status(404).json({
          error: "X task not found"
        });
      }

      const account =
        await getXAccount(req.tgUser.id);

      if (!account) {
        return res.status(400).json({
          error:
            "Connect your X account first"
        });
      }

      const already = await db(
        `
        SELECT 1
        FROM task_claims
        WHERE user_id = $1
          AND task_id = $2
        `,
        [
          req.tgUser.id,
          taskId
        ]
      );

      if (already.rows.length) {
        return res.status(400).json({
          error: "Task already claimed"
        });
      }

      let verified = false;

      if (task.type === "x_follow") {
        verified =
          await verifyXFollow(
            account.access_token,
            account.x_user_id
          );
      }

      if (task.type === "x_repost") {
        verified =
          await verifyXRepost(
            account.access_token,
            account.x_user_id
          );
      }

      if (!verified) {
        return res.status(400).json({
          error:
            "Task not completed yet"
        });
      }

      const client =
        await pool.connect();

      try {
        await client.query("BEGIN");

        const claim =
          await client.query(
            `
            INSERT INTO task_claims
              (user_id, task_id, claimed_at)
            VALUES
              ($1, $2, $3)
            ON CONFLICT (user_id, task_id)
            DO NOTHING
            RETURNING *
            `,
            [
              req.tgUser.id,
              taskId,
              now()
            ]
          );

        if (!claim.rows.length) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Task already claimed"
          });
        }

        await client.query(
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

        await client.query("COMMIT");

      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const user =
        await getUser(req.tgUser.id);

      res.json({
        success: true,
        verified: true,
        reward: Number(task.reward),
        user: publicUser(user)
      });

    } catch (err) {
      console.error(
        "X task verification error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "X verification failed"
      });
    }
  }
);
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
    CREATE TABLE IF NOT EXISTS x_accounts (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      x_user_id TEXT NOT NULL,
      x_username TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at BIGINT,
      scope TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS x_oauth_states (
      state TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at BIGINT NOT NULL
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
    await db(`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'telegram'
  `);

  await db(`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS target_id TEXT
  `);
  await db(`
    INSERT INTO tasks
      (title, url, channel, reward, active, type, target_id)
    SELECT
      'Follow VELTRIX on X',
      'https://x.com/VeltrixExchang',
      NULL,
      50,
      true,
      'x_follow',
      NULL
    WHERE NOT EXISTS (
      SELECT 1
      FROM tasks
      WHERE type = 'x_follow'
    )
  `);

  await db(`
    INSERT INTO tasks
      (title, url, channel, reward, active, type, target_id)
    SELECT
      'Repost VELTRIX post on X',
      'https://x.com/VeltrixExchang/status/2101180648618959312',
      NULL,
      35,
      true,
      'x_repost',
      '2101180648618959312'
    WHERE NOT EXISTS (
      SELECT 1
      FROM tasks
      WHERE type = 'x_repost'
    )
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
   MINING COMPLETE NOTIFICATION
========================= */

let notificationCheckRunning = false;

async function checkMiningNotifications() {
  if (notificationCheckRunning) return;

  notificationCheckRunning = true;

  try {
    const result = await db(`
      SELECT *
      FROM users
      WHERE EXTRACT(EPOCH FROM NOW())::BIGINT - cycle_start >= $1
        AND mining_notified_cycle IS DISTINCT FROM cycle_start
    `, [CYCLE_SECONDS]);

    for (const user of result.rows) {
      try {
        await bot.telegram.sendMessage(
          String(user.id),
          `⛏️ VELTRIX Mining Complete!\n\n` +
          `🎉 Your 8-hour mining cycle is complete.\n` +
          `💰 Reward: ${(RATE * CYCLE_HOURS).toFixed(2)} VLX\n\n` +
          `Open VELTRIX Miner and claim your reward 👇`,
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

        await db(`
          UPDATE users
          SET mining_notified_cycle = cycle_start
          WHERE id = $1
            AND mining_notified_cycle IS DISTINCT FROM cycle_start
        `, [user.id]);

      } catch (err) {
        console.error(
          `Notification failed for user ${user.id}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Mining notification checker error:", err);
  } finally {
    notificationCheckRunning = false;
  }
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
        t.type,
        t.target_id,
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
    setInterval(checkMiningNotifications, 60 * 1000);

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
