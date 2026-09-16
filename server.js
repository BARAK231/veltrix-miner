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

const RATE = 4.74;
const CYCLE_SECONDS = 8 * 60 * 60;
const REFERRAL_BONUS = 300;
const MIN_WITHDRAW = 10000;

const ADMIN_ID = String(process.env.ADMIN_ID || '');

const now = () => Math.floor(Date.now() / 1000);


// ==================================================
// DATABASE
// ==================================================

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    balance REAL DEFAULT 0,
    cycle_start INTEGER NOT NULL,
    wallet TEXT DEFAULT '',
    referred_by INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    channel TEXT NOT NULL,
    link TEXT NOT NULL,
    reward REAL NOT NULL,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS task_claims (
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, task_id)
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


// ==================================================
// USER
// ==================================================

function getUser(id) {
    return db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(Number(id));
}


function createUser(tgUser, referralId) {

    const existing = getUser(tgUser.id);

    if (existing) {
        return existing;
    }

    let referredBy = Number(referralId) || null;

    if (referredBy === Number(tgUser.id)) {
        referredBy = null;
    }

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
            cycle_start,
            wallet,
            referred_by,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        tgUser.id,
        tgUser.username || '',
        tgUser.first_name || '',
        0,
        timestamp,
        '',
        referredBy,
        timestamp
    );

    if (referredBy) {

        db.prepare(`
            UPDATE users
            SET balance = balance + ?
            WHERE id = ?
        `).run(
            REFERRAL_BONUS,
            referredBy
        );
    }

    return getUser(tgUser.id);
}


// ==================================================
// MINING
// ==================================================

function calculateMining(user) {

    const elapsed = Math.max(
        0,
        Math.min(
            now() - user.cycle_start,
            CYCLE_SECONDS
        )
    );

    return elapsed * RATE / 3600;
}


function publicUser(user) {

    const mining = calculateMining(user);

    const elapsed = Math.max(
        0,
        Math.min(
            now() - user.cycle_start,
            CYCLE_SECONDS
        )
    );

    const remaining = Math.max(
        0,
        CYCLE_SECONDS - elapsed
    );

    return {

        id: user.id,

        username: user.username,

        firstName: user.first_name,

        balance: Number(
            (user.balance + mining).toFixed(6)
        ),

        rate: RATE,

        wallet: user.wallet || '',

        minWithdraw: MIN_WITHDRAW,

        cycleHours: 8,

        cycleSeconds: CYCLE_SECONDS,

        cycleRemaining: remaining,

        canClaim: remaining === 0
    };
}


// ==================================================
// TELEGRAM SECURITY
// ==================================================

function verifyTelegram(initData) {

    if (!initData) {
        return null;
    }

    const params = new URLSearchParams(initData);

    const hash = params.get('hash');

    if (!hash) {
        return null;
    }

    params.delete('hash');

    const dataCheckString =
        [...params.entries()]
            .sort(([a], [b]) =>
                a.localeCompare(b)
            )
            .map(([key, value]) =>
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
        hash.length
    ) {
        return null;
    }

    if (
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
        !authDate ||
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


// ==================================================
// EXPRESS
// ==================================================

app.use(express.json());

app.use(
    express.static(
        path.join(
            __dirname,
            'web'
        )
    )
);


// ==================================================
// CONFIG
// ==================================================

app.get(
    '/api/config',
    (req, res) => {

        res.json({

            name: 'VELTRIX',

            ticker: 'VLX',

            rate: RATE,

            referral:
                REFERRAL_BONUS,

            minWithdraw:
                MIN_WITHDRAW,

            cycleHours: 8,

            cycleSeconds:
                CYCLE_SECONDS

        });

    }
);


// ==================================================
// LOGIN / USER
// ==================================================

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


// ==================================================
// MINING STATUS
// ==================================================

app.post(
    '/api/mining',
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


// ==================================================
// CLAIM
// ==================================================

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

        const elapsed =
            now() - user.cycle_start;

        if (
            elapsed <
            CYCLE_SECONDS
        ) {

            return res.status(400).json({

                error:
                    '8-hour mining cycle is not finished',

                remaining:
                    CYCLE_SECONDS - elapsed,

                user:
                    publicUser(user)

            });

        }

        const reward =
            calculateMining(user);

        const timestamp =
            now();

        db.prepare(`
            UPDATE users
            SET
                balance = balance + ?,
                cycle_start = ?
            WHERE id = ?
        `).run(
            reward,
            timestamp,
            user.id
        );

        res.json({

            ok: true,

            claimed:
                Number(
                    reward.toFixed(6)
                ),

            user:
                publicUser(
                    getUser(user.id)
                )

        });

    }
);


// ==================================================
// TASKS
// ==================================================

app.get(
    '/api/tasks',
    (req, res) => {

        const tasks =
            db.prepare(`
                SELECT
                    id,
                    title,
                    channel,
                    link,
                    reward
                FROM tasks
                WHERE active = 1
                ORDER BY id DESC
            `).all();

        res.json(tasks);

    }
);


// ==================================================
// TASK CLAIM
// ==================================================

app.post(
    '/api/task/claim',
    (req, res) => {

        const telegramUser =
            authenticate(
                req,
                res
            );

        if (!telegramUser) {
            return;
        }

        const taskId =
            Number(
                req.body?.taskId
            );

        const task =
            db.prepare(`
                SELECT *
                FROM tasks
                WHERE id = ?
                AND active = 1
            `).get(taskId);

        if (!task) {

            return res.status(404).json({
                error:
                    'Task not found'
            });

        }

        const already =
            db.prepare(`
                SELECT 1
                FROM task_claims
                WHERE user_id = ?
                AND task_id = ?
            `).get(
                telegramUser.id,
                taskId
            );

        if (already) {

            return res.status(400).json({
                error:
                    'Task already claimed'
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
            INSERT INTO task_claims
            (
                user_id,
                task_id,
                claimed_at
            )
            VALUES (?, ?, ?)
        `).run(
            telegramUser.id,
            taskId,
            now()
        );

        db.prepare(`
            UPDATE users
            SET balance = balance + ?
            WHERE id = ?
        `).run(
            task.reward,
            telegramUser.id
        );

        res.json({

            ok: true,

            reward:
                task.reward,

            user:
                publicUser(
                    getUser(
                        telegramUser.id
                    )
                )

        });

    }
);


// ==================================================
// WALLET
// ==================================================

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
            !/^0x[a-fA-F0-9]{40}$/.test(
                wallet
            )
        ) {

            return res.status(400).json({

                error:
                    'Invalid Ethereum/EVM wallet address'

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


// ==================================================
// WITHDRAW
// ==================================================

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

        if (
            !Number.isFinite(amount) ||
            amount < MIN_WITHDRAW
        ) {

            return res.status(400).json({

                error:
                    `Minimum withdrawal is ${MIN_WITHDRAW} VLX`

            });

        }

        if (!user.wallet) {

            return res.status(400).json({

                error:
                    'Save your wallet first'

            });

        }

        const currentBalance =
            Number(
                (
                    user.balance +
                    calculateMining(user)
                ).toFixed(6)
            );

        if (
            amount >
            currentBalance
        ) {

            return res.status(400).json({

                error:
                    'Insufficient VLX Points'

            });

        }

        const miningReward =
            calculateMining(user);

        const timestamp =
            now();

        db.prepare(`
            UPDATE users
            SET
                balance = balance + ?,
                cycle_start = ?
            WHERE id = ?
        `).run(
            miningReward,
            timestamp,
            user.id
        );

        db.prepare(`
            UPDATE users
            SET balance = balance - ?
            WHERE id = ?
        `).run(
            amount,
            user.id
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
            `).run(
                user.id,
                amount,
                user.wallet,
                'PENDING',
                timestamp
            );

        res.json({

            ok: true,

            id:
                withdrawal.lastInsertRowid,

            status:
                'PENDING',

            user:
                publicUser(
                    getUser(user.id)
                )

        });

    }
);


// ==================================================
// LEADERBOARD
// ==================================================

app.get(
    '/api/leaderboard',
    (req, res) => {

        const users =
            db.prepare(`
                SELECT
                    id,
                    username,
                    first_name,
                    balance
                FROM users
                ORDER BY balance DESC
                LIMIT 20
            `).all();

        res.json(
            users.map(
                (u, index) => ({

                    rank:
                        index + 1,

                    name:
                        u.username
                            ? '@' + u.username
                            : (
                                u.first_name ||
                                'User'
                            ),

                    balance:
                        Number(
                            u.balance.toFixed(2)
                        )

                })
            )
        );

    }
);


// ==================================================
// ADMIN — ADD TASK
// ==================================================

app.post(
    '/api/admin/task',
    (req, res) => {

        if (
            String(
                req.body?.adminId
            ) !== ADMIN_ID
        ) {

            return res.status(403).json({
                error:
                    'Forbidden'
            });

        }

        const title =
            String(
                req.body?.title || ''
            ).trim();

        const channel =
            String(
                req.body?.channel || ''
            ).trim();

        const link =
            String(
                req.body?.link || ''
            ).trim();

        const reward =
            Number(
                req.body?.reward
            );

        if (
            !title ||
            !channel ||
            !/^https?:\/\//.test(link) ||
            !Number.isFinite(reward) ||
            reward <= 0
        ) {

            return res.status(400).json({
                error:
                    'Invalid task data'
            });

        }

        const result =
            db.prepare(`
                INSERT INTO tasks
                (
                    title,
                    channel,
                    link,
                    reward,
                    active
                )
                VALUES (?, ?, ?, ?, 1)
            `).run(
                title,
                channel,
                link,
                reward
            );

        res.json({

            ok: true,

            id:
                result.lastInsertRowid

        });

    }
);


// ==================================================
// ADMIN — TASK LIST
// ==================================================

app.get(
    '/api/admin/tasks',
    (req, res) => {

        if (
            String(
                req.query.adminId
            ) !== ADMIN_ID
        ) {

            return res.status(403).json({
                error:
                    'Forbidden'
            });

        }

        res.json(
            db.prepare(`
                SELECT *
                FROM tasks
                ORDER BY id DESC
            `).all()
        );

    }
);


// ==================================================
// ADMIN — ENABLE / DISABLE TASK
// ==================================================

app.post(
    '/api/admin/task/toggle',
    (req, res) => {

        if (
            String(
                req.body?.adminId
            ) !== ADMIN_ID
        ) {

            return res.status(403).json({
                error:
                    'Forbidden'
            });

        }

        db.prepare(`
            UPDATE tasks
            SET active =
                CASE
                    WHEN active = 1 THEN 0
                    ELSE 1
                END
            WHERE id = ?
        `).run(
            Number(
                req.body?.id
            )
        );

        res.json({
            ok: true
        });

    }
);


// ==================================================
// ADMIN — WITHDRAWALS
// ==================================================

app.get(
    '/api/admin/withdrawals',
    (req, res) => {

        if (
            String(
                req.query.adminId
            ) !== ADMIN_ID
        ) {

            return res.status(403).json({
                error:
                    'Forbidden'
            });

        }

        const rows =
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

        res.json(rows);

    }
);


// ==================================================
// ADMIN — WITHDRAWAL STATUS
// ==================================================

app.post(
    '/api/admin/status',
    (req, res) => {

        if (
            String(
                req.body?.adminId
            ) !== ADMIN_ID
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
                    'Invalid status'
            });

        }

        db.prepare(`
            UPDATE withdrawals
            SET status = ?
            WHERE id = ?
        `).run(
            req.body.status,
            Number(
                req.body.id
            )
        );

        res.json({
            ok: true
        });

    }
);


// ==================================================
// TELEGRAM START
// ==================================================

bot.start(
    async (ctx) => {

        const appUrl =
            process.env.APP_URL;

        const refId =
            ctx.startPayload || '';

        const webAppUrl =
            refId
                ? `${appUrl}?ref=${encodeURIComponent(refId)}`
                : appUrl;

        const message =
            `⚡ VELTRIX (VLX)\n\n` +
            `⛏️ Mine VLX Points\n` +
            `👥 Referral Bonus: ${REFERRAL_BONUS} VLX\n` +
            `💸 Minimum Withdraw: ${MIN_WITHDRAW} VLX\n` +
            `⏱️ Mining Cycle: 8 Hours`;

        if (appUrl) {

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


// ==================================================
// TELEGRAM ID
// ==================================================

bot.command(
    'id',
    (ctx) => {

        ctx.reply(
            `Telegram ID: ${ctx.from.id}`
        );

    }
);


// ==================================================
// START
// ==================================================

bot.launch()
    .catch(
        (error) => {

            console.error(
                'Telegram bot failed:',
                error
            );

            process.exit(1);

        }
    );

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `VELTRIX running on port ${PORT}`
        );

    }
);

process.once(
    'SIGINT',
    () => bot.stop('SIGINT')
);

process.once(
    'SIGTERM',
    () => bot.stop('SIGTERM')
);
