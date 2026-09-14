import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { Telegraf } from 'telegraf';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const db = new Database('veltrix.db');
const bot = new Telegraf(process.env.BOT_TOKEN);

const PORT = Number(process.env.PORT || 3000);

// ===============================
// VELTRIX SETTINGS
// ===============================

const RATE = 4.74;              // VLX per hour
const CYCLE_HOURS = 8;          // Mining cycle
const CYCLE_SECONDS = 8 * 3600; // 28800 seconds

const REF = 300;                // Referral bonus
const MIN = 10000;              // Minimum withdrawal

const ADMIN = String(process.env.ADMIN_ID || '');

const now = () => Math.floor(Date.now() / 1000);


// ===============================
// DATABASE
// ===============================

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance REAL DEFAULT 0,
  rate REAL DEFAULT 4.74,
  last_update INTEGER,
  cycle_start INTEGER,
  wallet TEXT,
  referred_by INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount REAL,
  wallet TEXT,
  status TEXT DEFAULT 'PENDING',
  created_at INTEGER
);
`);


// ===============================
// GET USER
// ===============================

function getUser(id) {
  return db
    .prepare('SELECT * FROM users WHERE id=?')
    .get(Number(id));
}


// ===============================
// CREATE USER
// ===============================

function createUser(tg, ref) {

  let user = getUser(tg.id);

  if (user) {
    return user;
  }

  let referredBy = Number(ref) || null;

  // Prevent self referral
  if (referredBy === Number(tg.id)) {
    referredBy = null;
  }

  // Referral must be an existing user
  if (referredBy && !getUser(referredBy)) {
    referredBy = null;
  }

  const timestamp = now();

  db.prepare(`
    INSERT INTO users
    (
      id,
      username,
      first_name,
      balance,
      rate,
      last_update,
      cycle_start,
      wallet,
      referred_by,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tg.id,
    tg.username || '',
    tg.first_name || '',
    0,
    RATE,
    timestamp,
    timestamp,
    '',
    referredBy,
    timestamp
  );


  // Give referral bonus once
  if (referredBy) {

    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(
      REF,
      referredBy
    );
  }

  return getUser(tg.id);
}


// ===============================
// MINING CALCULATION
// ===============================

function accrue(user) {

  const current = now();

  let elapsed =
    Math.max(
      0,
      current - user.last_update
    );


  // Never allow more than 8 hours
  // in one mining cycle
  const remainingCycleTime =
    Math.max(
      0,
      CYCLE_SECONDS -
      (user.last_update - user.cycle_start)
    );


  elapsed =
    Math.min(
      elapsed,
      remainingCycleTime
    );


  const earned =
    elapsed *
    user.rate /
    3600;


  if (earned > 0) {

    db.prepare(`
      UPDATE users
      SET
        balance = balance + ?,
        last_update = ?
      WHERE id = ?
    `).run(
      earned,
      current,
      user.id
    );

  }


  return getUser(user.id);
}


// ===============================
// CLAIM
// ===============================

function claimMining(user) {

  const current = now();

  const cycleElapsed =
    current - user.cycle_start;


  // Cannot claim before 8 hours
  if (cycleElapsed < CYCLE_SECONDS) {

    return {
      success: false,
      remaining:
        CYCLE_SECONDS - cycleElapsed,
      user: publicUser(user)
    };

  }


  // Add final mining amount
  const finalUser =
    accrue(user);


  // Start a NEW 8 hour cycle
  db.prepare(`
    UPDATE users
    SET
      cycle_start = ?,
      last_update = ?
    WHERE id = ?
  `).run(
    current,
    current,
    user.id
  );


  return {
    success: true,
    remaining: CYCLE_SECONDS,
    user: publicUser(
      getUser(user.id)
    )
  };
}


// ===============================
// PUBLIC USER
// ===============================

function publicUser(user) {

  user = accrue(user);

  const current = now();

  const cycleElapsed =
    Math.max(
      0,
      current - user.cycle_start
    );


  const cycleRemaining =
    Math.max(
      0,
      CYCLE_SECONDS - cycleElapsed
    );


  return {

    id: user.id,

    username: user.username,

    firstName: user.first_name,

    balance:
      Number(
        user.balance.toFixed(6)
      ),

    rate: RATE,

    wallet:
      user.wallet || '',

    minWithdraw: MIN,

    cycleHours: CYCLE_HOURS,

    cycleSeconds: CYCLE_SECONDS,

    cycleRemaining,

    canClaim:
      cycleRemaining === 0

  };
}


// ===============================
// TELEGRAM SECURITY
// ===============================

function verifyTelegram(initData) {

  if (!initData) {
    return null;
  }

  const params =
    new URLSearchParams(initData);

  const hash =
    params.get('hash');

  if (!hash) {
    return null;
  }

  params.delete('hash');


  const dataCheckString =
    [...params.entries()]
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join('\n');


  const secretKey =
    crypto
      .createHmac(
        'sha256',
        'WebAppData'
      )
      .update(
        process.env.BOT_TOKEN
      )
      .digest();


  const calculatedHash =
    crypto
      .createHmac(
        'sha256',
        secretKey
      )
      .update(
        dataCheckString
      )
      .digest('hex');


  if (
    calculatedHash.length !==
      hash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {

    return null;
  }


  const authDate =
    Number(
      params.get('auth_date') || 0
    );


  if (
    now() - authDate > 86400
  ) {

    return null;
  }


  try {

    return JSON.parse(
      params.get('user') || 'null'
    );

  } catch {

    return null;

  }
}


// ===============================
// AUTHENTICATION
// ===============================

function authenticate(req, res) {

  const telegramUser =
    verifyTelegram(
      req.body?.initData
    );


  if (!telegramUser) {

    res.status(401).json({
      error:
        'Invalid Telegram session'
    });

    return null;
  }


  return telegramUser;
}


// ===============================
// EXPRESS
// ===============================

app.use(
  express.json()
);


app.use(
  express.static(
    path.join(
      __dirname,
      'web'
    )
  )
);


// ===============================
// CONFIG
// ===============================

app.get(
  '/api/config',
  (req, res) => {

    res.json({

      name: 'VELTRIX',

      ticker: 'VLX',

      rate: RATE,

      referral: REF,

      minWithdraw: MIN,

      cycleHours: CYCLE_HOURS,

      cycleSeconds:
        CYCLE_SECONDS

    });

  }
);


// ===============================
// USER LOGIN
// ===============================

app.post(
  '/api/user',
  (req, res) => {

    const telegramUser =
      verifyTelegram(
        req.body?.initData
      );


    if (!telegramUser) {

      return res.status(401).json({
        error:
          'Invalid Telegram session'
      });

    }


    const user =
      createUser(
        telegramUser,
        req.body?.startParam
      );


    res.json(
      publicUser(user)
    );

  }
);


// ===============================
// UPDATE MINING BALANCE
// ===============================

app.post(
  '/api/claim',
  (req, res) => {

    const telegramUser =
      authenticate(
        req,
        res
      );


    if (!telegramUser) {
      return;
    }


    const user =
      getUser(
        telegramUser.id
      );


    if (!user) {

      return res.status(404).json({
        error:
          'User not found'
      });

    }


    res.json({

      ok: true,

      user:
        publicUser(user)

    });

  }
);


// ===============================
// FINAL 8-HOUR CLAIM
// ===============================

app.post(
  '/api/claim-cycle',
  (req, res) => {

    const telegramUser =
      authenticate(
        req,
        res
      );


    if (!telegramUser) {
      return;
    }


    const user =
      getUser(
        telegramUser.id
      );


    if (!user) {

      return res.status(404).json({
        error:
          'User not found'
      });

    }


    const result =
      claimMining(user);


    if (!result.success) {

      return res.status(400).json({

        error:
          '8 hour mining cycle is not finished',

        remaining:
          result.remaining,

        user:
          result.user

      });

    }


    res.json({

      ok: true,

      message:
        'Mining cycle claimed',

      user:
        result.user

    });

  }
);


// ===============================
// BOOST
// ===============================

app.post(
  '/api/boost',
  (req, res) => {

    const telegramUser =
      authenticate(
        req,
        res
      );


    if (!telegramUser) {
      return;
    }


    const user =
      getUser(
        telegramUser.id
      );


    if (!user) {

      return res.status(404).json({
        error:
          'User not found'
      });

    }


    // Keep existing boost feature
    db.prepare(`
      UPDATE users
      SET rate = rate + 0.5
      WHERE id = ?
    `).run(
      user.id
    );


    res.json({

      ok: true,

      user:
        publicUser(
          getUser(user.id)
        )

    });

  }
);


// ===============================
// SAVE WALLET
// ===============================

app.post(
  '/api/wallet',
  (req, res) => {

    const telegramUser =
      authenticate(
        req,
        res
      );


    if (!telegramUser) {
      return;
    }


    const wallet =
      String(
        req.body?.wallet || ''
      ).trim();


    if (
      wallet.length < 20 ||
      wallet.length > 200
    ) {

      return res.status(400).json({
        error:
          'Invalid wallet address'
      });

    }


    const user =
      getUser(
        telegramUser.id
      );


    if (!user) {

      return res.status(404).json({
        error:
          'User not found'
      });

    }


    db.prepare(`
      UPDATE users
      SET wallet = ?
      WHERE id = ?
    `).run(
      wallet,
      telegramUser.id
    );


    res.json({

      ok: true,

      user:
        publicUser(
          getUser(
            telegramUser.id
          )
        )

    });

  }
);


// ===============================
// WITHDRAW
// ===============================

app.post(
  '/api/withdraw',
  (req, res) => {

    const telegramUser =
      authenticate(
        req,
        res
      );


    if (!telegramUser) {
      return;
    }


    const amount =
      Number(
        req.body?.amount
      );


    const user =
      getUser(
        telegramUser.id
      );


    if (!user) {

      return res.status(404).json({
        error:
          'User not found'
      });

    }


    const updated =
      accrue(user);


    if (
      !Number.isFinite(amount) ||
      amount < MIN
    ) {

      return res.status(400).json({

        error:
          `Minimum withdrawal is ${MIN} VLX Points`

      });

    }


    if (!updated.wallet) {

      return res.status(400).json({

        error:
          'Save your wallet first'

      });

    }


    if (
      amount >
      updated.balance
    ) {

      return res.status(400).json({

        error:
          'Insufficient VLX Points'

      });

    }


    db.prepare(`
      UPDATE users
      SET balance = balance - ?
      WHERE id = ?
    `).run(
      amount,
      updated.id
    );


    const withdrawal =
      db.prepare(`
        INSERT INTO withdrawals
        (
          user_id,
          amount,
          wallet,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        updated.id,
        amount,
        updated.wallet,
        'PENDING',
        now()
      );


    res.json({

      ok: true,

      id:
        withdrawal.lastInsertRowid,

      status:
        'PENDING',

      user:
        publicUser(
          getUser(
            updated.id
          )
        )

    });

  }
);


// ===============================
// ADMIN WITHDRAWALS
// ===============================

app.get(
  '/api/admin/withdrawals',
  (req, res) => {

    if (
      String(
        req.query.adminId
      ) !== ADMIN
    ) {

      return res.status(403).json({
        error:
          'Forbidden'
      });

    }


    const withdrawals =
      db.prepare(`
        SELECT
          w.*,
          u.username,
          u.first_name
        FROM withdrawals w
        JOIN users u
          ON u.id = w.user_id
        ORDER BY w.id DESC
        LIMIT 200
      `).all();


    res.json(
      withdrawals
    );

  }
);


// ===============================
// ADMIN STATUS
// ===============================

app.post(
  '/api/admin/status',
  (req, res) => {

    if (
      String(
        req.body?.adminId
      ) !== ADMIN
    ) {

      return res.status(403).json({
        error:
          'Forbidden'
      });

    }


    const allowed = [
      'PENDING',
      'APPROVED',
      'REJECTED',
      'PAID'
    ];


    if (
      !allowed.includes(
        req.body?.status
      )
    ) {

      return res.status(400).json({
        error:
          'Bad status'
      });

    }


    db.prepare(`
      UPDATE withdrawals
      SET status = ?
      WHERE id = ?
    `).run(
      req.body.status,
      Number(req.body.id)
    );


    res.json({
      ok: true
    });

  }
);


// ===============================
// TELEGRAM START
// ===============================

bot.start(
  async (ctx) => {

    const appUrl =
      process.env.APP_URL;


    const refId =
      ctx.startPayload || '';


    const message =
      `⚡ VELTRIX (VLX)\n\n` +
      `⛏️ Mine VLX Points and invite friends!\n\n` +
      `👥 Referral Bonus: ${REF} VLX\n` +
      `💸 Minimum Withdraw: ${MIN} VLX\n` +
      `⏱️ Mining Cycle: ${CYCLE_HOURS} Hours\n\n` +
      `⚠️ VLX Points are currently off-chain. ` +
      `Future token distribution and listing will be announced by the project.`;


    if (appUrl) {

      const webAppUrl =
        refId
          ? `${appUrl}?ref=${encodeURIComponent(refId)}`
          : appUrl;


      await ctx.reply(
        message,
        {
          reply_markup: {

            inline_keyboard: [

              [

                {
                  text:
                    '⛏️ OPEN VELTRIX MINER',

                  web_app: {
                    url:
                      webAppUrl
                  }

                }

              ]

            ]

          }

        }
      );

    } else {

      await ctx.reply(
        message
      );

    }

  }
);


// ===============================
// TELEGRAM ID
// ===============================

bot.command(
  'id',
  (ctx) => {

    ctx.reply(
      `Telegram ID: ${ctx.from.id}`
    );

  }
);


// ===============================
// START BOT
// ===============================

bot.launch()
  .catch(
    (error) => {

      console.error(
        'Telegram bot failed to start:',
        error
      );

      process.exit(1);

    }
  );


// ===============================
// START SERVER
// ===============================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `VELTRIX Mini App running on port ${PORT}`
    );

  }
);


// ===============================
// SHUTDOWN
// ===============================

process.once(
  'SIGINT',
  () => bot.stop('SIGINT')
);

process.once(
  'SIGTERM',
  () => bot.stop('SIGTERM')
);
