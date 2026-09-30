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

const RATE = 1.25;
const CYCLE_HOURS = 8;
const CYCLE_SECONDS = CYCLE_HOURS * 3600;

const REFERRAL_BONUS = 300;
const MIN_WITHDRAW = 10000;

// =========================
// VELTRIX PRESALE
// =========================
const PRESALE_RATE = 5000;
const PRESALE_ALLOCATION = 150000000;

const PRESALE_TON_ADDRESS =
  "UQASlSXzQBNaRnFNLgui-Xp_LqZ4NNuTUODRsBAm--sAph8u";

const PRESALE_ORDER_TTL = 30 * 60;

const TONCENTER_API_KEY =
  process.env.TONCENTER_API_KEY || "";

// =========================
// X / TWITTER
// =========================
const X_CLIENT_ID = process.env.X_CLIENT_ID || "";
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || "";

const X_CALLBACK_URL = `${APP_URL}/api/x/callback`;

const X_OFFICIAL_USERNAME = "VeltrixExchang";
const X_REPOST_POST_ID = "2101180648618959312";

const X_FOLLOW_REWARD = 50;
const X_REPOST_REWARD = 35;

// =========================
// DATABASE
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const db = (query, params = []) =>
  pool.query(query, params);

const now = () =>
  Math.floor(Date.now() / 1000);

// =========================
// MINING HELPERS
// =========================
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

// =========================
// TELEGRAM WEB APP AUTH
// =========================
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

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(checkString)
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

// =========================
// CREATE USER
// =========================
async function createUser(tg, ref = null) {
  const id = Number(tg.id);

  const existing = await db(
    "SELECT * FROM users WHERE id=$1",
    [id]
  );

  if (existing.rows.length) {
    return existing.rows[0];
  }

  let referredBy = null;

  if (
    ref &&
    String(ref) !== String(id) &&
    /^\d+$/.test(String(ref))
  ) {
    const referrer = await db(
      "SELECT id FROM users WHERE id=$1",
      [Number(ref)]
    );

    if (referrer.rows.length) {
      referredBy = Number(ref);
    }
  }

  const result = await db(
    `INSERT INTO users
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
      $1,$2,$3,0,$4,NULL,$5,$6
    )
    RETURNING *`,
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
      "UPDATE users SET balance=balance+$1 WHERE id=$2",
      [REFERRAL_BONUS, referredBy]
    );
  }

  return result.rows[0];
}

// =========================
// DATABASE INITIALIZATION
// =========================
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

  await db(`
    CREATE TABLE IF NOT EXISTS x_accounts(
      user_id BIGINT PRIMARY KEY,
      x_user_id TEXT NOT NULL,
      username TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS x_oauth_states(
      state TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

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
    ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'telegram'
  `);

  await db(`
    ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS target_id TEXT
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS task_claims(
      user_id BIGINT NOT NULL,
      task_id INTEGER NOT NULL,
      claimed_at BIGINT NOT NULL,
      PRIMARY KEY(user_id,task_id)
    )
  `);

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
    ADD COLUMN IF NOT EXISTS verified_at BIGINT
  `);

  await db(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    presale_orders_tx_hash_unique
    ON presale_orders(tx_hash)
    WHERE tx_hash IS NOT NULL
  `).catch(() => {});

  const followTask = await db(
    "SELECT id FROM tasks WHERE type='x_follow' LIMIT 1"
  );

  if (!followTask.rows.length) {
    await db(
      `INSERT INTO tasks
      (
        title,
        description,
        reward,
        type,
        target,
        active,
        created_at
      )
      VALUES
      ($1,$2,$3,'x_follow',$4,TRUE,$5)`,
      [
        "Follow VELTRIX on X",
        "Follow @VeltrixExchang",
        X_FOLLOW_REWARD,
        X_OFFICIAL_USERNAME,
        now(),
      ]
    );
  }

  const repostTask = await db(
    "SELECT id FROM tasks WHERE type='x_repost' LIMIT 1"
  );

  if (!repostTask.rows.length) {
    await db(
      `INSERT INTO tasks
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
      ($1,$2,$3,'x_repost',$4,$5,TRUE,$6)`,
      [
        "Repost VELTRIX",
        "Repost official VELTRIX post",
        X_REPOST_REWARD,
        `https://x.com/${X_OFFICIAL_USERNAME}/status/${X_REPOST_POST_ID}`,
        X_REPOST_POST_ID,
        now(),
      ]
    );
  }
}

// =========================
// HEALTH
// =========================
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// TON CONNECT MANIFEST
// =========================
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

// =========================
// FRONTEND
// =========================
app.get("/", (req, res) => {
  try {
    const indexPath = path.join(
      __dirname,
      "web",
      "index.html"
    );

    if (!fs.existsSync(indexPath)) {
      return res
        .status(404)
        .send("VELTRIX Mini App not found");
    }

    let html = fs.readFileSync(
      indexPath,
      "utf8"
    );

    res.send(html);
  } catch (e) {
    res.status(500).send(
      "VELTRIX server error"
    );
  }
});

// =========================
// USER API
// =========================
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// MINING CLAIM
// =========================
app.post(
  "/api/claim",
  auth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        "SELECT * FROM users WHERE id=$1 FOR UPDATE",
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
          error: "Mining cycle is not complete",
          remaining: remaining(user),
        });
      }

      const reward =
        RATE * CYCLE_HOURS;

      const updated = await client.query(
        `UPDATE users
         SET
           balance=balance+$1,
           cycle_start=$2,
           mining_notified_cycle=0
         WHERE id=$3
         RETURNING *`,
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
    } catch (e) {
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

// =========================
// X / TWITTER HELPERS
// =========================
function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function randomString(length = 32) {
  return base64url(
    crypto.randomBytes(length)
  );
}

function pkceChallenge(verifier) {
  return base64url(
    crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
  );
}

function xBasicAuth() {
  return Buffer.from(
    `${X_CLIENT_ID}:${X_CLIENT_SECRET}`
  ).toString("base64");
}

async function xTokenRequest(params) {
  const response = await fetch(
    "https://api.x.com/2/oauth2/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",

        Authorization:
          `Basic ${xBasicAuth()}`,
      },

      body: new URLSearchParams(
        params
      ),
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
        data?.detail ||
        "X token request failed"
    );
  }

  return data;
}

async function xApi(
  pathname,
  accessToken,
  options = {}
) {
  const response = await fetch(
    `https://api.x.com${pathname}`,
    {
      ...options,

      headers: {
        ...(options.headers || {}),

        Authorization:
          `Bearer ${accessToken}`,
      },
    }
  );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.detail ||
        data?.title ||
        data?.error ||
        `X API error ${response.status}`
    );
  }

  return data;
}

async function getXAccount(userId) {
  const result = await db(
    "SELECT * FROM x_accounts WHERE user_id=$1",
    [userId]
  );

  return result.rows[0] || null;
}

async function getXOfficialUserId(
  accessToken
) {
  const data = await xApi(
    `/2/users/by/username/${encodeURIComponent(
      X_OFFICIAL_USERNAME
    )}?user.fields=id,username`,
    accessToken
  );

  return data?.data?.id || null;
}

async function verifyXFollow(account) {
  const officialId =
    await getXOfficialUserId(
      account.access_token
    );

  if (!officialId) {
    return false;
  }

  let pagination = "";

  for (let i = 0; i < 5; i++) {
    const url =
      `/2/users/${encodeURIComponent(
        account.x_user_id
      )}/following?max_results=1000` +
      (
        pagination
          ? `&pagination_token=${encodeURIComponent(
              pagination
            )}`
          : ""
      );

    const data = await xApi(
      url,
      account.access_token
    );

    if (
      (data.data || []).some(
        x =>
          String(x.id) ===
          String(officialId)
      )
    ) {
      return true;
    }

    if (!data.meta?.next_token) {
      break;
    }

    pagination =
      data.meta.next_token;
  }

  return false;
}

async function verifyXRepost(
  account
) {
  const data = await xApi(
    `/2/users/${encodeURIComponent(
      account.x_user_id
    )}/retweeted_tweets?max_results=100`,
    account.access_token
  );

  return (
    data.data || []
  ).some(
    x =>
      String(x.id) ===
      String(X_REPOST_POST_ID)
  );
}

// =========================
// X AUTH
// =========================
app.get(
  "/api/x/auth",
  auth,
  async (req, res) => {
    try {
      if (
        !X_CLIENT_ID ||
        !X_CLIENT_SECRET
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "X OAuth is not configured",
        });
      }

      const verifier =
        randomString(48);

      const challenge =
        pkceChallenge(verifier);

      const state =
        randomString(32);

      const userId =
        Number(req.tgUser.id);

      await db(
        "DELETE FROM x_oauth_states WHERE user_id=$1",
        [userId]
      );

      await db(
        `INSERT INTO x_oauth_states
        (
          state,
          user_id,
          code_verifier,
          created_at
        )
        VALUES
        ($1,$2,$3,$4)`,
        [
          state,
          userId,
          verifier,
          now(),
        ]
      );

      const url = new URL(
        "https://twitter.com/i/oauth2/authorize"
      );

      url.searchParams.set(
        "response_type",
        "code"
      );

      url.searchParams.set(
        "client_id",
        X_CLIENT_ID
      );

      url.searchParams.set(
        "redirect_uri",
        X_CALLBACK_URL
      );

      url.searchParams.set(
        "scope",
        "tweet.read users.read follows.read offline.access"
      );

      url.searchParams.set(
        "state",
        state
      );

      url.searchParams.set(
        "code_challenge",
        challenge
      );

      url.searchParams.set(
        "code_challenge_method",
        "S256"
      );

      res.json({
        ok: true,
        url: url.toString(),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// X CALLBACK
// =========================
app.get(
  "/api/x/callback",
  async (req, res) => {
    try {
      const {
        code,
        state,
        error,
        error_description,
      } = req.query;

      if (error) {
        return res
          .status(400)
          .send(
            `X authorization failed: ${
              error_description ||
              error
            }`
          );
      }

      if (!code || !state) {
        return res
          .status(400)
          .send(
            "Missing X authorization code or state"
          );
      }

      const result = await db(
        "SELECT * FROM x_oauth_states WHERE state=$1",
        [String(state)]
      );

      if (!result.rows.length) {
        return res
          .status(400)
          .send(
            "Invalid or expired X OAuth state"
          );
      }

      const oauth =
        result.rows[0];

      if (
        Number(oauth.created_at) <
        now() - 600
      ) {
        await db(
          "DELETE FROM x_oauth_states WHERE state=$1",
          [String(state)]
        );

        return res
          .status(400)
          .send(
            "X OAuth state expired"
          );
      }

      const token =
        await xTokenRequest({
          code: String(code),
          grant_type:
            "authorization_code",
          redirect_uri:
            X_CALLBACK_URL,
          code_verifier:
            oauth.code_verifier,
        });

      const me = await xApi(
        "/2/users/me?user.fields=id,username,name",
        token.access_token
      );

      const xUser =
        me?.data;

      if (!xUser?.id) {
        throw new Error(
          "Could not read X account"
        );
      }

      const expiresAt =
        token.expires_in
          ? now() +
            Number(token.expires_in)
          : null;

      await db(
        `INSERT INTO x_accounts
        (
          user_id,
          x_user_id,
          username,
          access_token,
          refresh_token,
          expires_at,
          created_at
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7)

        ON CONFLICT(user_id)
        DO UPDATE SET
          x_user_id=EXCLUDED.x_user_id,
          username=EXCLUDED.username,
          access_token=EXCLUDED.access_token,
          refresh_token=EXCLUDED.refresh_token,
          expires_at=EXCLUDED.expires_at`,
        [
          Number(oauth.user_id),
          String(xUser.id),
          xUser.username || "",
          token.access_token,
          token.refresh_token ||
            null,
          expiresAt,
          now(),
        ]
      );

      await db(
        "DELETE FROM x_oauth_states WHERE state=$1",
        [String(state)]
      );

      res.send(`
        <html>
          <body
            style="
              font-family:sans-serif;
              text-align:center;
              padding:40px
            "
          >
            <h2>
              ✅ X account connected
            </h2>

            <p>
              @${String(
                xUser.username || ""
              ).replace(
                /[<>]/g,
                ""
              )}
            </p>

            <p>
              You can return to VELTRIX.
            </p>

            <script>
              setTimeout(
                () => window.close(),
                1200
              );
            </script>
          </body>
        </html>
      `);
    } catch (e) {
      console.error(
        "X callback:",
        e.message
      );

      res
        .status(500)
        .send(
          `X connection failed: ${e.message}`
        );
    }
  }
);

// =========================
// X STATUS
// =========================
app.get(
  "/api/x/status",
  auth,
  async (req, res) => {
    try {
      const account =
        await getXAccount(
          Number(req.tgUser.id)
        );

      res.json({
        ok: true,

        connected:
          Boolean(account),

        account: account
          ? {
              id: account.x_user_id,
              username:
                account.username,
              expiresAt:
                account.expires_at
                  ? Number(
                      account.expires_at
                    )
                  : null,
            }
          : null,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// X TASK VERIFY
// =========================
app.post(
  "/api/x/verify-task",
  auth,
  async (req, res) => {
    try {
      const userId =
        Number(req.tgUser.id);

      const type =
        String(
          req.body.type || ""
        );

      const account =
        await getXAccount(
          userId
        );

      if (!account) {
        return res.status(400).json({
          ok: false,
          error:
            "Connect your X account first",
        });
      }

      let verified = false;

      if (type === "x_follow") {
        verified =
          await verifyXFollow(
            account
          );
      } else if (
        type === "x_repost"
      ) {
        verified =
          await verifyXRepost(
            account
          );
      } else {
        return res.status(400).json({
          ok: false,
          error:
            "Unknown X task",
        });
      }

      res.json({
        ok: true,
        verified,
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// TASKS
// =========================
app.get(
  "/api/tasks",
  auth,
  async (req, res) => {
    try {
      const result = await db(
        `SELECT
          t.*,
          CASE
            WHEN tc.user_id IS NULL
            THEN FALSE
            ELSE TRUE
          END claimed

        FROM tasks t

        LEFT JOIN task_claims tc
          ON tc.task_id=t.id
          AND tc.user_id=$1

        WHERE t.active=TRUE

        ORDER BY t.id`,
        [Number(req.tgUser.id)]
      );

      res.json({
        ok: true,

        tasks: result.rows.map(
          task => ({
            id: Number(task.id),

            title:
              task.title,

            description:
              task.description ||
              "",

            reward:
              Number(
                task.reward || 0
              ),

            type:
              task.type,

            target:
              task.target || "",

            targetId:
              task.target_id ||
              "",

            claimed:
              Boolean(
                task.claimed
              ),
          })
        ),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// TELEGRAM BOT HOLDER
// =========================
let bot = null;

// =========================
// TASK CLAIM
// =========================
app.post(
  "/api/task/claim",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const taskId =
        Number(
          req.body.taskId
        );

      const userId =
        Number(req.tgUser.id);

      const taskResult =
        await client.query(
          `SELECT *
           FROM tasks
           WHERE id=$1
           AND active=TRUE`,
          [taskId]
        );

      if (!taskResult.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Task not found",
        });
      }

      const task =
        taskResult.rows[0];

      const already =
        await client.query(
          `SELECT 1
           FROM task_claims
           WHERE user_id=$1
           AND task_id=$2`,
          [
            userId,
            taskId,
          ]
        );

      if (already.rows.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Task already claimed",
        });
      }

      // Telegram task
      if (task.type === "telegram") {
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
        } catch (e) {
          return res.status(400).json({
            ok: false,
            error:
              "Membership verification failed. Make sure the bot is admin in the channel.",
          });
        }

        if (
          ![
            "creator",
            "administrator",
            "member",
            "restricted",
          ].includes(
            member.status
          )
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Please join the Telegram channel first.",
          });
        }
      }

      // X tasks
      if (
        task.type === "x_follow" ||
        task.type === "x_repost"
      ) {
        const account =
          await getXAccount(
            userId
          );

        if (!account) {
          return res.status(400).json({
            ok: false,
            error:
              "Connect your X account first",
          });
        }

        const verified =
          task.type ===
          "x_follow"
            ? await verifyXFollow(
                account
              )
            : await verifyXRepost(
                account
              );

        if (!verified) {
          return res.status(400).json({
            ok: false,
            error:
              task.type ===
              "x_follow"
                ? "Follow @VeltrixExchang on X first."
                : "Repost the official VELTRIX post first.",
          });
        }
      }

      await client.query(
        "BEGIN"
      );

      await client.query(
        `INSERT INTO task_claims
        (
          user_id,
          task_id,
          claimed_at
        )
        VALUES
        ($1,$2,$3)`,
        [
          userId,
          taskId,
          now(),
        ]
      );

      await client.query(
        `UPDATE users
         SET balance=balance+$1
         WHERE id=$2`,
        [
          Number(
            task.reward || 0
          ),
          userId,
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        reward:
          Number(
            task.reward || 0
          ),
      });
    } catch (e) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error: e.message,
      });
    } finally {
      client.release();
    }
  }
);

// =========================
// REFERRAL
// =========================
app.get(
  "/api/referral",
  auth,
  async (req, res) => {
    try {
      const userId =
        Number(req.tgUser.id);

      const result =
        await db(
          `SELECT COUNT(*)::int count
           FROM users
           WHERE referred_by=$1`,
          [userId]
        );

      const referrals =
        Number(
          result.rows[0]?.count ||
            0
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// LEADERBOARD
// =========================
app.get(
  "/api/leaderboard",
  auth,
  async (req, res) => {
    try {
      const result =
        await db(
          `SELECT
            id,
            username,
            first_name,
            balance

           FROM users

           ORDER BY balance DESC

           LIMIT 100`
        );

      res.json({
        ok: true,

        leaderboard:
          result.rows.map(
            (user, index) => ({
              rank:
                index + 1,

              id:
                Number(user.id),

              username:
                user.username ||
                "",

              first_name:
                user.first_name ||
                "",

              balance:
                Number(
                  user.balance ||
                    0
                ),
            })
          ),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// SOLANA WALLET
// =========================
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
          "SELECT wallet FROM users WHERE id=$1",
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
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
          req.body.wallet ||
            ""
        ).trim();

      if (!validSolana(wallet)) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid Solana wallet address",
        });
      }

      await db(
        `UPDATE users
         SET wallet=$1
         WHERE id=$2`,
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// WITHDRAW
// =========================
app.post(
  "/api/withdraw",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const amount =
        Number(
          req.body.amount
        );

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

      await client.query(
        "BEGIN"
      );

      const result =
        await client.query(
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
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
          `SELECT id
           FROM withdrawals
           WHERE user_id=$1
           AND status='PENDING'
           LIMIT 1`,
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
        `UPDATE users
         SET balance=balance-$1
         WHERE id=$2`,
        [
          amount,
          userId,
        ]
      );

      const withdrawal =
        await client.query(
          `INSERT INTO withdrawals
          (
            user_id,
            amount,
            wallet,
            status,
            created_at
          )
          VALUES
          (
            $1,$2,$3,'PENDING',$4
          )
          RETURNING *`,
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
    } catch (e) {
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
// =========================
// PRESALE HELPERS
// =========================

async function expireOrders() {
  await db(
    `UPDATE presale_orders
     SET status='EXPIRED'
     WHERE status='PENDING'
     AND created_at < $1`,
    [now() - PRESALE_ORDER_TTL]
  );
}

async function sold() {
  const result = await db(
    `SELECT COALESCE(
      SUM(vlx_amount),0
    ) sold
    FROM presale_orders
    WHERE status='APPROVED'`
  );

  return Number(
    result.rows[0]?.sold || 0
  );
}

async function reserved() {
  const result = await db(
    `SELECT COALESCE(
      SUM(vlx_amount),0
    ) reserved
    FROM presale_orders
    WHERE status='PENDING'
    AND created_at >= $1`,
    [now() - PRESALE_ORDER_TTL]
  );

  return Number(
    result.rows[0]?.reserved || 0
  );
}

function validTon(wallet) {
  if (
    typeof wallet !== "string"
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
    Number(amount) * 1e9
  );
}

// =========================
// PRESALE CONFIG
// =========================

app.get(
  "/api/presale/config",
  async (req, res) => {
    try {
      await expireOrders();

      const totalSold =
        await sold();

      const totalReserved =
        await reserved();

      const remaining =
        Math.max(
          0,
          PRESALE_ALLOCATION -
            totalSold -
            totalReserved
        );

      res.json({
        ok: true,

        active:
          totalSold +
            totalReserved <
          PRESALE_ALLOCATION,

        rate:
          PRESALE_RATE,

        allocation:
          PRESALE_ALLOCATION,

        sold:
          totalSold,

        reserved:
          totalReserved,

        remaining,

        tonAddress:
          PRESALE_TON_ADDRESS,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// CREATE PRESALE ORDER
// =========================

app.post(
  "/api/presale/create-order",
  auth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const tonAmount =
        Number(
          req.body.tonAmount
        );

      const wallet =
        String(
          req.body.wallet || ""
        ).trim();

      if (
        !Number.isFinite(
          tonAmount
        ) ||
        tonAmount < 0.01
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

      const totalSold =
        await sold();

      const totalReserved =
        await reserved();

      const vlxAmount =
        tonAmount *
        PRESALE_RATE;

      if (
        totalSold +
          totalReserved +
          vlxAmount >
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
          `INSERT INTO presale_orders
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
            $1,$2,$3,$4,
            NULL,
            'PENDING',
            $5
          )
          RETURNING *`,
          [
            Number(
              req.tgUser.id
            ),

            tonAmount,

            vlxAmount,

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

          ton_amount:
            tonAmount,

          vlx_amount:
            vlxAmount,

          wallet,

          status:
            "PENDING",
        },

        destination:
          PRESALE_TON_ADDRESS,
      });
    } catch (e) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error:
          "Presale order failed",
      });
    } finally {
      client.release();
    }
  }
);

// =========================
// TON CENTER
// =========================

async function tonMessages(
  params
) {
  const url = new URL(
    "https://toncenter.com/api/v3/messages"
  );

  for (
    const [key, value]
    of Object.entries(params)
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

// =========================
// FIND TON PAYMENT
// =========================

async function findPayment(
  order
) {
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

      direction:
        "in",

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
    message =>
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

// =========================
// VERIFY PRESALE ORDER
// =========================

async function verifyOrder(
  orderId
) {
  const client =
    await pool.connect();

  try {
    const result =
      await client.query(
        `SELECT *
         FROM presale_orders
         WHERE id=$1`,
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
        `UPDATE presale_orders
         SET status='EXPIRED'
         WHERE id=$1`,
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

    const txHash =
      payment.hash ||
      payment.message_hash;

    const duplicate =
      await db(
        `SELECT id
         FROM presale_orders
         WHERE tx_hash=$1
         AND id<>$2`,
        [
          txHash,
          orderId,
        ]
      );

    if (duplicate.rows.length) {
      await db(
        `UPDATE presale_orders
         SET status='REJECTED'
         WHERE id=$1`,
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
        `UPDATE presale_orders
         SET
           status='APPROVED',
           tx_hash=$1,
           verified_at=$2
         WHERE id=$3
         RETURNING *`,
        [
          txHash,
          now(),
          orderId,
        ]
      );

    await client.query(
      `UPDATE users
       SET presale_balance =
         COALESCE(
           presale_balance,
           0
         ) + $1
       WHERE id=$2`,
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
  } catch (e) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    console.error(
      "Presale verification:",
      e.message
    );

    return null;
  } finally {
    client.release();
  }
}

// =========================
// USER PRESALE ORDER
// =========================

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
          `SELECT *
           FROM presale_orders
           WHERE id=$1
           AND user_id=$2`,
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// USER PRESALE ORDERS
// =========================

app.get(
  "/api/presale/orders",
  auth,
  async (req, res) => {
    try {
      await expireOrders();

      const result =
        await db(
          `SELECT *
           FROM presale_orders
           WHERE user_id=$1
           ORDER BY id DESC
           LIMIT 50`,
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// ADMIN TASKS
// =========================

app.get(
  "/api/admin/tasks",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          "SELECT * FROM tasks ORDER BY id DESC"
        );

      res.json({
        ok: true,
        tasks:
          result.rows,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

app.post(
  "/api/admin/tasks",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `INSERT INTO tasks
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
            $1,$2,$3,$4,
            $5,$6,
            TRUE,
            $7
          )
          RETURNING *`,
          [
            req.body.title,

            req.body.description ||
              "",

            Number(
              req.body.reward || 0
            ),

            req.body.type ||
              "telegram",

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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

app.post(
  "/api/admin/tasks/:id/toggle",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `UPDATE tasks
           SET active=NOT active
           WHERE id=$1
           RETURNING *`,
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
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

app.delete(
  "/api/admin/tasks/:id",
  adminAuth,
  async (req, res) => {
    try {
      const id =
        Number(
          req.params.id
        );

      await db(
        "DELETE FROM task_claims WHERE task_id=$1",
        [id]
      );

      await db(
        "DELETE FROM tasks WHERE id=$1",
        [id]
      );

      res.json({
        ok: true,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// ADMIN WITHDRAWALS
// =========================

app.get(
  "/api/admin/withdrawals",
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await db(
          `SELECT
            w.*,
            u.username,
            u.first_name

           FROM withdrawals w

           LEFT JOIN users u
           ON u.id=w.user_id

           ORDER BY w.id DESC

           LIMIT 200`
        );

      res.json({
        ok: true,
        withdrawals:
          result.rows,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

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
          req.body.status ||
            ""
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
          `SELECT *
           FROM withdrawals
           WHERE id=$1
           FOR UPDATE`,
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
          `UPDATE users
           SET balance=balance+$1
           WHERE id=$2`,
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
        `UPDATE withdrawals
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

         WHERE id=$4`,
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
    } catch (e) {
      await client.query(
        "ROLLBACK"
      );

      res.status(500).json({
        ok: false,
        error: e.message,
      });
    } finally {
      client.release();
    }
  }
);

// =========================
// ADMIN PRESALE
// =========================

app.get(
  "/api/admin/presale/orders",
  adminAuth,
  async (req, res) => {
    try {
      await expireOrders();

      const result =
        await db(
          `SELECT
            p.*,
            u.username,
            u.first_name

           FROM presale_orders p

           LEFT JOIN users u
           ON u.id=p.user_id

           ORDER BY p.id DESC

           LIMIT 500`
        );

      res.json({
        ok: true,
        orders:
          result.rows,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

app.get(
  "/api/admin/presale/status",
  adminAuth,
  async (req, res) => {
    try {
      await expireOrders();

      const totalSold =
        await sold();

      const totalReserved =
        await reserved();

      res.json({
        ok: true,

        rate:
          PRESALE_RATE,

        allocation:
          PRESALE_ALLOCATION,

        sold:
          totalSold,

        reserved:
          totalReserved,

        remaining:
          Math.max(
            0,
            PRESALE_ALLOCATION -
              totalSold -
              totalReserved
          ),

        tonAddress:
          PRESALE_TON_ADDRESS,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// ADMIN STATUS
// =========================

app.get(
  "/api/admin/status",
  adminAuth,
  async (req, res) => {
    try {
      const users =
        await db(
          `SELECT COUNT(*)::int count
           FROM users`
        );

      const balance =
        await db(
          `SELECT COALESCE(
            SUM(balance),0
          ) total
          FROM users`
        );

      const withdrawals =
        await db(
          `SELECT COUNT(*)::int count
           FROM withdrawals
           WHERE status='PENDING'`
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
            withdrawals.rows[0].count
          ),

        presaleSold:
          await sold(),
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// =========================
// MINING NOTIFICATIONS
// =========================

async function miningNotifications() {
  if (!bot) {
    return;
  }

  try {
    const result =
      await db(
        `SELECT *
         FROM users
         WHERE cycle_start IS NOT NULL
         AND cycle_start+$1 <= $2
         LIMIT 500`,
        [
          CYCLE_SECONDS,
          now(),
        ]
      );

    for (
      const user
      of result.rows
    ) {
      const cycle =
        Number(
          user.cycle_start
        );

      if (
        Number(
          user.mining_notified_cycle ||
            0
        ) === cycle
      ) {
        continue;
      }

      try {
        await bot.telegram.sendMessage(
          Number(user.id),

          `⛏️ VELTRIX Mining Complete!

🎉 Your ${CYCLE_HOURS}-hour mining cycle is complete.

💰 Reward: ${(RATE * CYCLE_HOURS).toFixed(
            2
          )} VLX

👇 Claim your VLX now.`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "⛏️ Claim VLX",

                    web_app: {
                      url:
                        APP_URL,
                    },
                  },
                ],
              ],
            },
          }
        );

        await db(
          `UPDATE users
           SET mining_notified_cycle=$1
           WHERE id=$2`,
          [
            cycle,
            Number(user.id),
          ]
        );
      } catch (e) {
        // Ignore individual Telegram errors
      }
    }
  } catch (e) {
    console.error(
      "Notification checker:",
      e.message
    );
  }
}

// =========================
// TELEGRAM BOT
// =========================

if (BOT_TOKEN) {
  bot = new Telegraf(
    BOT_TOKEN
  );

  bot.start(
    async ctx => {
      try {
        await createUser(
          ctx.from,
          ctx.startPayload ||
            null
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
                    text:
                      "⛏️ Mine VLX",

                    web_app: {
                      url:
                        `${APP_URL}?ref=${ctx.from.id}`,
                    },
                  },

                  {
                    text:
                      "💎 VLX Presale",

                    web_app: {
                      url:
                        `${APP_URL}?section=presale&ref=${ctx.from.id}`,
                    },
                  },
                ],
              ],
            },
          }
        );
      } catch (e) {
        await ctx.reply(
          "VELTRIX is temporarily unavailable. Please try again."
        );
      }
    }
  );

  bot.catch(
    e =>
      console.error(
        "Telegram:",
        e.message
      )
  );
}

// =========================
// START SERVER
// =========================

async function start() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () =>
        console.log(
          `VELTRIX running on ${PORT}`
        )
    );

    setInterval(
      miningNotifications,
      60 * 1000
    );

    if (bot) {
      bot
        .launch()
        .then(() =>
          console.log(
            "VELTRIX bot started"
          )
        )
        .catch(e =>
          console.error(
            "Bot launch:",
            e.message
          )
        );
    } else {
      console.error(
        "BOT_TOKEN missing"
      );
    }
  } catch (e) {
    console.error(
      "Startup failed:",
      e
    );

    process.exit(1);
  }
}

start();

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
