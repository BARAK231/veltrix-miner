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
const RATE = Number(process.env.MINING_PER_HOUR || 4.57);
const REF = Number(process.env.REFERRAL_BONUS || 300);
const MIN = Number(process.env.WITHDRAW_MIN || 10000);
const ADMIN = String(process.env.ADMIN_ID || '');

const now = () => Math.floor(Date.now() / 1000);

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance REAL DEFAULT 0,
  rate REAL DEFAULT 4.57,
  last_update INTEGER,
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

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));
}

function createUser(tg, ref) {
  let user = getUser(tg.id);

  if (user) return user;

  let referredBy = Number(ref) || null;

  if (
    referredBy === Number(tg.id) ||
    !getUser(referredBy)
  ) {
    referredBy = null;
  }

  db.prepare(`
    INSERT INTO users
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    tg.id,
    tg.username || '',
    tg.first_name || '',
    0,
    RATE,
    now(),
    '',
    referredBy,
    now()
  );

  if (referredBy) {
    db.prepare(
      'UPDATE users SET balance=balance+? WHERE id=?'
    ).run(REF, referredBy);
  }

  return getUser(tg.id);
}

function accrue(user) {
  const t = now();

  const earned =
    Math.max(0, t - user.last_update) *
    user.rate / 3600;

  db.prepare(`
    UPDATE users
    SET balance=balance+?, last_update=?
    WHERE id=?
  `).run(earned, t, user.id);

  return getUser(user.id);
}

function publicUser(user) {
  user = accrue(user);

  return {
    id: user.id,
    username: user.username,
    firstName: user.first_name,
    balance: Number(user.balance.toFixed(6)),
    rate: Number(user.rate.toFixed(6)),
    wallet: user.wallet || '',
    minWithdraw: MIN
  };
}

function verifyTelegram(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');

  if (!hash) return null;

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (
    calculatedHash.length !== hash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(hash)
    )
  ) {
    return null;
  }

  if (
    now() - Number(params.get('auth_date') || 0) > 86400
  ) {
    return null;
  }

  return JSON.parse(params.get('user') || 'null');
}

function authenticate(req, res) {
  const telegramUser = verifyTelegram(
    req.body?.initData
  );

  if (!telegramUser) {
    res.status(401).json({
      error: 'Invalid Telegram session'
    });
    return null;
  }

  return telegramUser;
}

app.use(express.json());

app.use(
  express.static(path.join(__dirname, 'web'))
);

app.get('/api/config', (req, res) => {
  res.json({
    name: 'VELTRIX',
    ticker: 'VLX',
    rate: RATE,
    referral: REF,
    minWithdraw: MIN
  });
});

app.post('/api/user', (req, res) => {
  const telegramUser = verifyTelegram(
    req.body?.initData
  );

  if (!telegramUser) {
    return res.status(401).json({
      error: 'Invalid Telegram session'
    });
  }

  const user = createUser(
    telegramUser,
    req.body?.startParam
  );

  res.json(publicUser(user));
});

app.post('/api/claim', (req, res) => {
  const telegramUser = authenticate(req, res);

  if (!telegramUser) return;

  const user = getUser(telegramUser.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post('/api/boost', (req, res) => {
  const telegramUser = authenticate(req, res);

  if (!telegramUser) return;

  const user = getUser(telegramUser.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  const updated = accrue(user);

  db.prepare(`
    UPDATE users
    SET rate=rate+0.5
    WHERE id=?
  `).run(updated.id);

  res.json({
    ok: true,
    user: publicUser(getUser(updated.id))
  });
});

app.post('/api/wallet', (req, res) => {
  const telegramUser = authenticate(req, res);

  if (!telegramUser) return;

  const wallet = String(
    req.body?.wallet || ''
  ).trim();

  if (wallet.length < 20 || wallet.length > 200) {
    return res.status(400).json({
      error: 'Invalid wallet address'
    });
  }

  const user = getUser(telegramUser.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  db.prepare(`
    UPDATE users
    SET wallet=?
    WHERE id=?
  `).run(wallet, telegramUser.id);

  res.json({
    ok: true,
    user: publicUser(
      getUser(telegramUser.id)
    )
  });
});

app.post('/api/withdraw', (req, res) => {
  const telegramUser = authenticate(req, res);

  if (!telegramUser) return;

  const amount = Number(req.body?.amount);
  const user = getUser(telegramUser.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  const updated = accrue(user);

  if (!Number.isFinite(amount) || amount < MIN) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${MIN} VLX Points`
    });
  }

  if (!updated.wallet) {
    return res.status(400).json({
      error: 'Save your wallet first'
    });
  }

  if (amount > updated.balance) {
    return res.status(400).json({
      error: 'Insufficient VLX Points'
    });
  }

  db.prepare(`
    UPDATE users
    SET balance=balance-?
    WHERE id=?
  `).run(amount, updated.id);

  const withdrawal = db.prepare(`
    INSERT INTO withdrawals
    (user_id, amount, wallet, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    updated.id,
    amount,
    updated.wallet,
    'PENDING',
    now()
  );

  res.json({
    ok: true,
    id: withdrawal.lastInsertRowid,
    user: publicUser(
      getUser(updated.id)
    )
  });
});

app.get('/api/admin/withdrawals', (req, res) => {
  if (
    String(req.query.adminId) !== ADMIN
  ) {
    return res.status(403).json({
      error: 'Forbidden'
    });
  }

  const withdrawals = db.prepare(`
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

  res.json(withdrawals);
});

app.post('/api/admin/status', (req, res) => {
  if (
    String(req.body?.adminId) !== ADMIN
  ) {
    return res.status(403).json({
      error: 'Forbidden'
    });
  }

  const allowed = [
    'PENDING',
    'APPROVED',
    'REJECTED',
    'PAID'
  ];

  if (!allowed.includes(req.body?.status)) {
    return res.status(400).json({
      error: 'Bad status'
    });
  }

  db.prepare(`
    UPDATE withdrawals
    SET status=?
    WHERE id=?
  `).run(
    req.body.status,
    Number(req.body.id)
  );

  res.json({
    ok: true
  });
});

bot.start(async (ctx) => {
  const appUrl = process.env.APP_URL;

  const message =
    `⚡ VELTRIX (VLX)\n\n` +
    `⛏️ Mine VLX Points and invite friends!\n\n` +
    `👥 Referral Bonus: ${REF} VLX\n` +
    `💸 Minimum Withdraw: ${MIN} VLX\n\n` +
    `⚠️ VLX Points are currently off-chain. ` +
    `Future token distribution and listing will be announced by the project.`;

  if (appUrl) {
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '⛏️ OPEN VELTRIX MINER',
              web_app: {
                url: appUrl
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

bot.command('id', (ctx) => {
  ctx.reply(
    `Telegram ID: ${ctx.from.id}`
  );
});

bot.launch().catch((error) => {
  console.error(
    'Telegram bot failed to start:',
    error
  );
  process.exit(1);
});

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `VELTRIX Mini App running on port ${PORT}`
    );
  }
);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
