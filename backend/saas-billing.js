const crypto = require('crypto');
const path = require('path');

const SESSION_COOKIE = 'agenda_session';
const SESSION_DAYS = 30;
const MERCADO_PAGO_API = 'https://api.mercadopago.com';

function getPlanConfig(env = process.env) {
    const monthlyPrice = Number(env.SUBSCRIPTION_AMOUNT_BRL || 50);
    const trialDays = Number(env.TRIAL_DAYS || 7);

    if (!Number.isFinite(monthlyPrice) || monthlyPrice < 1 || monthlyPrice > 100000) {
        throw new Error('SUBSCRIPTION_AMOUNT_BRL must be between 1 and 100000.');
    }
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
        throw new Error('TRIAL_DAYS must be an integer between 0 and 365.');
    }

    return { monthlyPrice: Number(monthlyPrice.toFixed(2)), trialDays };
}

async function ensureSaasSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_accounts (
            id UUID PRIMARY KEY,
            space_id INTEGER,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            store_name TEXT NOT NULL,
            store_segment TEXT NOT NULL DEFAULT 'outros',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS space_id INTEGER;
        CREATE UNIQUE INDEX IF NOT EXISTS saas_accounts_space_id_idx ON saas_accounts(space_id);
        DO $saas$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'saas_accounts_space_id_fkey'
                  AND conrelid = 'public.saas_accounts'::regclass
            ) THEN
                ALTER TABLE public.saas_accounts
                ADD CONSTRAINT saas_accounts_space_id_fkey
                FOREIGN KEY (space_id) REFERENCES public.espacos(id) ON DELETE RESTRICT;
            END IF;
        END
        $saas$;
        CREATE TABLE IF NOT EXISTS saas_sessions (
            token_hash CHAR(64) PRIMARY KEY,
            account_id UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_sessions_account_id_idx ON saas_sessions(account_id);
        CREATE TABLE IF NOT EXISTS saas_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            account_id UUID NOT NULL UNIQUE REFERENCES saas_accounts(id) ON DELETE CASCADE,
            provider TEXT NOT NULL DEFAULT 'mercadopago',
            provider_subscription_id TEXT UNIQUE,
            provider_status TEXT NOT NULL DEFAULT 'trialing',
            amount_brl NUMERIC(10, 2) NOT NULL,
            trial_days INTEGER NOT NULL DEFAULT 7,
            trial_started_at TIMESTAMPTZ,
            trial_ends_at TIMESTAMPTZ,
            next_payment_at TIMESTAMPTZ,
            checkout_url TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map((cookie) => {
        const separator = cookie.indexOf('=');
        if (separator < 0) return ['', ''];
        let value;
        try {
            value = decodeURIComponent(cookie.slice(separator + 1).trim());
        } catch {
            return ['', ''];
        }
        return [
            cookie.slice(0, separator).trim(),
            value
        ];
    }).filter(([key]) => key));
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
    const [algorithm, saltHex, hashHex] = storedHash.split('$');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function serializeSessionCookie(token, env = process.env) {
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function isValidEmail(email) {
    return typeof email === 'string'
        && email.length <= 254
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidCheckoutUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && /(^|\.)mercadopago\.com(\.[a-z]{2})?$/.test(url.hostname);
    } catch {
        return false;
    }
}

function isValidWebhookSignature(headers, dataId, secret, now = Date.now()) {
    const signatureHeader = headers['x-signature'];
    const requestId = headers['x-request-id'];
    if (!signatureHeader || !requestId || !dataId || !secret) return false;

    const signature = Object.fromEntries(signatureHeader.split(',').map((part) => {
        const [key, ...valueParts] = part.trim().split('=');
        return [key, valueParts.join('=')];
    }));
    let timestamp = Number(signature.ts);
    if (timestamp < 1e12) timestamp *= 1000;
    if (!signature.v1 || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1000) return false;

    const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${signature.ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
    let supplied;
    try {
        supplied = Buffer.from(signature.v1, 'hex');
    } catch {
        return false;
    }
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function effectiveSubscription(subscription, now = new Date()) {
    if (!subscription) return { status: 'not_started', can_access: false };

    const providerStatus = subscription.provider_status;
    const trialEndsAt = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null;
    const trialIsActive = trialEndsAt && trialEndsAt > now;
    let status = providerStatus;

    if (providerStatus === 'authorized') status = 'active';
    else if (trialIsActive) status = 'trialing';
    else if (providerStatus === 'trialing') status = 'expired';
    else if (providerStatus === 'cancelled' || providerStatus === 'canceled') status = 'cancelled';
    else if (providerStatus === 'paused') status = 'paused';
    else if (providerStatus === 'rejected') status = 'payment_failed';
    else if (providerStatus === 'pending') status = 'payment_pending';
    else if (providerStatus === 'expired') status = 'expired';

    return {
        status,
        can_access: status === 'active' || status === 'trialing',
        amount_brl: Number(subscription.amount_brl),
        trial_days: subscription.trial_days,
        trial_ends_at: subscription.trial_ends_at,
        next_payment_at: subscription.next_payment_at,
        checkout_url: subscription.checkout_url
    };
}

function createSaasBilling(app, pool, frontendDirectory) {
    let schemaPromise;
    const ensureSchema = () => {
        if (!schemaPromise) {
            schemaPromise = ensureSaasSchema(pool).catch((error) => {
                schemaPromise = undefined;
                throw error;
            });
        }
        return schemaPromise;
    };

    async function getAccountForRequest(req) {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!token || !/^[\da-f]{64}$/i.test(token)) return null;

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const result = await pool.query(`
            SELECT a.id, a.space_id, a.full_name, a.email, a.store_name, a.store_segment,
                   s.provider_subscription_id, s.provider_status, s.amount_brl,
                   s.trial_days, s.trial_ends_at, s.next_payment_at, s.checkout_url
            FROM saas_sessions session
            JOIN saas_accounts a ON a.id = session.account_id
            LEFT JOIN saas_subscriptions s ON s.account_id = a.id
            WHERE session.token_hash = $1 AND session.expires_at > NOW()
        `, [tokenHash]);

        return result.rows[0] || null;
    }

    function requireAccount(handler) {
        return async (req, res, next) => {
            try {
                await ensureSchema();
                req.saasAccount = await getAccountForRequest(req);
                if (!req.saasAccount) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
                return handler(req, res, next);
            } catch (error) {
                console.error('SaaS account request failed:', error);
                return res.status(500).json({ error: 'Não foi possível validar sua conta.' });
            }
        };
    }

    function requireOwnedSpace(handler) {
        return async (req, res, next) => {
            try {
                await ensureSchema();
                const account = await getAccountForRequest(req);
                if (!account) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
                if (!/^\d+$/.test(req.params.id || '')) {
                    return res.status(400).json({ error: 'ID de estabelecimento inválido.' });
                }
                if (!account.space_id || String(account.space_id) !== String(req.params.id)) {
                    return res.status(403).json({ error: 'Este estabelecimento não pertence à sua conta.' });
                }
                if (!effectiveSubscription(account).can_access) {
                    return res.status(402).json({ error: 'Sua assinatura não está ativa.' });
                }
                req.saasAccount = account;
                return handler(req, res, next);
            } catch (error) {
                console.error('SaaS establishment authorization failed:', error);
                return res.status(500).json({ error: 'Não foi possível validar o estabelecimento.' });
            }
        };
    }

    async function createSession(accountId, res) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query(`
            INSERT INTO saas_sessions (token_hash, account_id, expires_at)
            VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'))
        `, [tokenHash, accountId, SESSION_DAYS]);
        res.setHeader('Set-Cookie', serializeSessionCookie(token));
    }

    app.get('/api/saas/plan', (req, res) => {
        try {
            const plan = getPlanConfig();
            res.json({
                currency: 'BRL',
                amount: plan.monthlyPrice,
                interval: 'monthly',
                trial_days: plan.trialDays
            });
        } catch (error) {
            res.status(503).json({ error: 'A configuração da assinatura está inválida.' });
        }
    });

    app.post('/api/saas/register', async (req, res) => {
        const { nome, email, senha, nome_loja, segmento } = req.body || {};
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
            return res.status(400).json({ error: 'Informe seu nome completo.' });
        }
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        if (typeof senha !== 'string' || senha.length < 10 || senha.length > 200) {
            return res.status(400).json({ error: 'A senha deve ter pelo menos 10 caracteres.' });
        }
        if (typeof nome_loja !== 'string' || nome_loja.trim().length < 2 || nome_loja.trim().length > 150) {
            return res.status(400).json({ error: 'Informe o nome do estabelecimento.' });
        }

        try {
            await ensureSchema();
            const plan = getPlanConfig();
            const accountId = crypto.randomUUID();
            const normalizedEmail = email.trim().toLowerCase();
            const storeSegment = typeof segmento === 'string' && segmento.trim().length <= 50
                ? segmento.trim()
                : 'outros';
            const slugBase = nome_loja.trim()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 80) || 'estabelecimento';
            const storeSlug = `${slugBase}-${crypto.randomBytes(6).toString('hex')}`;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const spaceResult = await client.query(`
                    INSERT INTO espacos (nome, slug, nicho)
                    VALUES ($1, $2, $3)
                    RETURNING id
                `, [nome_loja.trim(), storeSlug, storeSegment]);
                const spaceId = spaceResult.rows[0].id;
                await client.query(`
                    INSERT INTO saas_accounts (id, space_id, full_name, email, password_hash, store_name, store_segment)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [
                    accountId,
                    spaceId,
                    nome.trim(),
                    normalizedEmail,
                    hashPassword(senha),
                    nome_loja.trim(),
                    storeSegment
                ]);
                await client.query(`
                    INSERT INTO saas_subscriptions
                        (account_id, provider_status, amount_brl, trial_days, trial_started_at, trial_ends_at, next_payment_at)
                    VALUES ($1, $2, $3, $4, NOW(), NOW() + ($4::integer * INTERVAL '1 day'), NOW() + ($4::integer * INTERVAL '1 day'))
                `, [accountId, plan.trialDays > 0 ? 'trialing' : 'pending', plan.monthlyPrice, plan.trialDays]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            await createSession(accountId, res);
            res.status(201).json({ message: 'Conta criada.', next: '/assinatura.html' });
        } catch (error) {
            if (error.code === '23505' && error.constraint === 'saas_accounts_email_key') {
                return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
            }
            console.error('SaaS registration failed:', error);
            res.status(500).json({ error: 'Não foi possível criar a conta.' });
        }
    });

    app.post('/api/saas/login', async (req, res) => {
        const { email, senha } = req.body || {};
        if (!isValidEmail(email) || typeof senha !== 'string' || senha.length > 200) {
            return res.status(400).json({ error: 'Informe um e-mail e uma senha válidos.' });
        }

        try {
            await ensureSchema();
            const result = await pool.query(`
                SELECT id, password_hash FROM saas_accounts WHERE email = $1
            `, [email.trim().toLowerCase()]);
            const account = result.rows[0];
            if (!account || !verifyPassword(senha, account.password_hash)) {
                return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
            }
            await createSession(account.id, res);
            res.json({ message: 'Sessão iniciada.', next: '/assinatura.html' });
        } catch (error) {
            console.error('SaaS login failed:', error);
            res.status(500).json({ error: 'Não foi possível entrar na conta.' });
        }
    });

    app.post('/api/saas/logout', async (req, res) => {
        try {
            const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
            if (token && /^[\da-f]{64}$/i.test(token)) {
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                await ensureSchema();
                await pool.query('DELETE FROM saas_sessions WHERE token_hash = $1', [tokenHash]);
            }
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
            res.json({ message: 'Sessão encerrada.' });
        } catch (error) {
            console.error('SaaS logout failed:', error);
            res.status(500).json({ error: 'Não foi possível encerrar a sessão.' });
        }
    });

    app.get('/api/saas/me', requireAccount((req, res) => {
        const { provider_subscription_id, provider_status, ...account } = req.saasAccount;
        const subscription = effectiveSubscription({
            provider_status,
            amount_brl: req.saasAccount.amount_brl,
            trial_days: req.saasAccount.trial_days,
            trial_ends_at: req.saasAccount.trial_ends_at,
            next_payment_at: req.saasAccount.next_payment_at,
            checkout_url: req.saasAccount.checkout_url
        });
        subscription.has_provider_subscription = Boolean(provider_subscription_id);
        subscription.can_cancel = Boolean(provider_subscription_id)
            && ['authorized', 'pending', 'paused'].includes(provider_status);
        res.json({ account, subscription });
    }));

    app.post('/api/saas/checkout', requireAccount(async (req, res) => {
        const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
        const appBaseUrl = process.env.APP_BASE_URL;
        if (!token || !appBaseUrl) {
            return res.status(503).json({ error: 'Configure MERCADOPAGO_ACCESS_TOKEN e APP_BASE_URL no backend.' });
        }
        try {
            const baseUrl = new URL(appBaseUrl);
            if (!['http:', 'https:'].includes(baseUrl.protocol)
                || baseUrl.username
                || baseUrl.password
                || baseUrl.search
                || baseUrl.hash
                || (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')) {
                return res.status(503).json({ error: 'APP_BASE_URL deve usar HTTPS em produção.' });
            }
        } catch {
            return res.status(503).json({ error: 'APP_BASE_URL não contém uma URL válida.' });
        }
        if (req.saasAccount.provider_status === 'authorized') {
            return res.status(409).json({ error: 'Sua assinatura já está ativa.' });
        }
        if (req.saasAccount.provider_status === 'pending' && req.saasAccount.checkout_url) {
            return res.json({ checkout_url: req.saasAccount.checkout_url });
        }

        try {
            const plan = getPlanConfig();
            const now = new Date();
            const trialEndsAt = req.saasAccount.trial_ends_at ? new Date(req.saasAccount.trial_ends_at) : now;
            const firstChargeAt = trialEndsAt > now ? trialEndsAt : now;
            const idempotencyKey = crypto.randomUUID();
            const autoRecurring = {
                frequency: 1,
                frequency_type: 'months',
                transaction_amount: plan.monthlyPrice,
                currency_id: 'BRL'
            };
            if (trialEndsAt > now) autoRecurring.start_date = trialEndsAt.toISOString();

            const response = await fetch(`${MERCADO_PAGO_API}/preapproval`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': idempotencyKey
                },
                body: JSON.stringify({
                    reason: `Agenda+ - Plano mensal ${plan.monthlyPrice.toFixed(2)} BRL`,
                    external_reference: req.saasAccount.id,
                    payer_email: req.saasAccount.email,
                    back_url: new URL('/assinatura.html?retorno=mercadopago', appBaseUrl).toString(),
                    notification_url: new URL('/api/webhooks/mercadopago', appBaseUrl).toString(),
                    auto_recurring: autoRecurring,
                    status: 'pending'
                })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                console.error('Mercado Pago subscription creation failed:', response.status, payload.message || payload.error);
                return res.status(502).json({ error: 'O Mercado Pago não conseguiu iniciar a assinatura. Tente novamente.' });
            }
            const checkoutUrl = payload.init_point || payload.sandbox_init_point;
            if (!payload.id || !isValidCheckoutUrl(checkoutUrl)) {
                console.error('Mercado Pago returned an incomplete subscription response.');
                return res.status(502).json({ error: 'O Mercado Pago retornou uma resposta incompleta.' });
            }

            await pool.query(`
                UPDATE saas_subscriptions
                SET provider_subscription_id = $1,
                    provider_status = $2,
                    amount_brl = $3,
                    checkout_url = $4,
                    next_payment_at = $5,
                    updated_at = NOW()
                WHERE account_id = $6
            `, [
                String(payload.id),
                payload.status || 'pending',
                plan.monthlyPrice,
                checkoutUrl,
                firstChargeAt,
                req.saasAccount.id
            ]);
            res.json({ checkout_url: checkoutUrl, trial_ends_at: req.saasAccount.trial_ends_at });
        } catch (error) {
            console.error('Mercado Pago checkout failed:', error);
            res.status(502).json({ error: 'Não foi possível conectar ao Mercado Pago.' });
        }
    }));

    app.post('/api/saas/cancel', requireAccount(async (req, res) => {
        const subscriptionId = req.saasAccount.provider_subscription_id;
        if (!subscriptionId) return res.status(409).json({ error: 'Não existe assinatura para cancelar.' });
        if (!['authorized', 'pending', 'paused'].includes(req.saasAccount.provider_status)) {
            return res.status(409).json({ error: 'Esta assinatura não pode ser cancelada neste status.' });
        }
        if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
            return res.status(503).json({ error: 'A cobrança ainda não está configurada.' });
        }

        try {
            const response = await fetch(`${MERCADO_PAGO_API}/preapproval/${encodeURIComponent(subscriptionId)}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ status: 'cancelled' })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                console.error('Mercado Pago cancellation failed:', response.status, payload.message || payload.error);
                return res.status(502).json({ error: 'Não foi possível cancelar no Mercado Pago.' });
            }
            await pool.query(`
                UPDATE saas_subscriptions
                SET provider_status = $1, updated_at = NOW()
                WHERE account_id = $2
            `, [payload.status || 'cancelled', req.saasAccount.id]);
            res.json({ message: 'Assinatura cancelada.' });
        } catch (error) {
            console.error('Mercado Pago cancellation failed:', error);
            res.status(502).json({ error: 'Não foi possível conectar ao Mercado Pago.' });
        }
    }));

    app.post('/api/webhooks/mercadopago', async (req, res) => {
        const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
        const dataId = req.query['data.id'] || req.body?.data?.id;
        const notificationType = req.body?.type || req.query.type || req.query.topic;
        if (!['string', 'number'].includes(typeof dataId) || String(dataId).length > 100) {
            return res.status(400).json({ error: 'Identificador de assinatura inválido.' });
        }
        if (!webhookSecret) return res.status(503).json({ error: 'Webhook do Mercado Pago não configurado.' });
        if (!isValidWebhookSignature(req.headers, dataId, webhookSecret)) {
            return res.status(401).json({ error: 'Assinatura de webhook inválida.' });
        }
        if (notificationType && !['subscription_preapproval', 'preapproval'].includes(notificationType)) {
            return res.sendStatus(200);
        }
        if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return res.status(503).json({ error: 'Mercado Pago não configurado.' });

        try {
            await ensureSchema();
            const response = await fetch(`${MERCADO_PAGO_API}/preapproval/${encodeURIComponent(dataId)}`, {
                headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` }
            });
            const subscription = await response.json().catch(() => ({}));
            if (!response.ok) {
                console.error('Mercado Pago webhook lookup failed:', response.status, subscription.message || subscription.error);
                return res.status(502).json({ error: 'Não foi possível validar a assinatura no Mercado Pago.' });
            }

            const result = await pool.query(`
                UPDATE saas_subscriptions
                SET provider_status = $1,
                    amount_brl = COALESCE($2, amount_brl),
                    next_payment_at = COALESCE($3, next_payment_at),
                    updated_at = NOW()
                WHERE provider_subscription_id = $4
                  AND account_id = $5
                RETURNING account_id
            `, [
                subscription.status || 'pending',
                subscription.auto_recurring?.transaction_amount ?? null,
                subscription.next_payment_date || null,
                String(dataId),
                subscription.external_reference
            ]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Assinatura não encontrada.' });
            res.sendStatus(200);
        } catch (error) {
            console.error('Mercado Pago webhook processing failed:', error);
            res.status(500).json({ error: 'Não foi possível processar a notificação.' });
        }
    });

    app.get('/admin.html', async (req, res) => {
        try {
            await ensureSchema();
            req.saasAccount = await getAccountForRequest(req);
            if (!req.saasAccount) return res.redirect('/index.html?next=admin.html');

            const subscription = effectiveSubscription(req.saasAccount);
            if (!subscription.can_access || !req.saasAccount.space_id) return res.redirect('/assinatura.html');
            res.sendFile(path.join(frontendDirectory, 'admin.html'));
        } catch (error) {
            console.error('Owner dashboard access check failed:', error);
            res.status(503).send('Não foi possível validar o acesso. Tente novamente.');
        }
    });

    return { requireOwnedSpace };
}

module.exports = {
    createSaasBilling,
    effectiveSubscription,
    getPlanConfig,
    hashPassword,
    isValidWebhookSignature,
    verifyPassword
};
