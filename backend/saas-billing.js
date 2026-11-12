const crypto = require('crypto');
const path = require('path');
const { isValidScheduleBlock } = require('./schedule-utils');

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
            whatsapp_phone TEXT,
            whatsapp_opt_in_at TIMESTAMPTZ,
            password_hash TEXT NOT NULL,
            store_name TEXT NOT NULL,
            store_segment TEXT NOT NULL DEFAULT 'outros',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS space_id INTEGER;
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT;
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
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
        CREATE TABLE IF NOT EXISTS saas_password_resets (
            token_hash CHAR(64) PRIMARY KEY,
            account_id UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_password_resets_account_id_idx ON saas_password_resets(account_id);
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
        CREATE TABLE IF NOT EXISTS saas_customers (
            id UUID PRIMARY KEY,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            phone TEXT NOT NULL,
            photo_url TEXT,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_customers ADD COLUMN IF NOT EXISTS photo_url TEXT;
        CREATE TABLE IF NOT EXISTS saas_employees (
            id UUID PRIMARY KEY,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            photo_url TEXT,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_employees ADD COLUMN IF NOT EXISTS photo_url TEXT;
        CREATE TABLE IF NOT EXISTS saas_employee_spaces (
            employee_id UUID NOT NULL REFERENCES saas_employees(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            company_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0,
            linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (employee_id, space_id)
        );
        ALTER TABLE saas_employee_spaces
            ADD COLUMN IF NOT EXISTS company_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS saas_employee_codes (
            space_id INTEGER PRIMARY KEY REFERENCES espacos(id) ON DELETE CASCADE,
            created_by UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            code_hash CHAR(64) NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS saas_service_professionals (
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            service_id TEXT NOT NULL,
            professional_type TEXT NOT NULL CHECK (professional_type IN ('owner', 'employee')),
            professional_id UUID NOT NULL,
            PRIMARY KEY (space_id, service_id, professional_type, professional_id)
        );
        CREATE INDEX IF NOT EXISTS saas_service_professionals_service_idx
            ON saas_service_professionals(space_id, service_id);
        CREATE TABLE IF NOT EXISTS configuracoes_horarios (
            espaco_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
            hora_inicio TIME NOT NULL,
            hora_fim TIME NOT NULL,
            ativo BOOLEAN NOT NULL DEFAULT FALSE,
            PRIMARY KEY (espaco_id, dia_semana)
        );
        CREATE TABLE IF NOT EXISTS saas_schedule_blocks (
            id UUID PRIMARY KEY,
            owner_space_id INTEGER REFERENCES espacos(id) ON DELETE CASCADE,
            employee_id UUID REFERENCES saas_employees(id) ON DELETE CASCADE,
            tipo_alvo TEXT NOT NULL CHECK (tipo_alvo IN ('dia', 'horario')),
            tipo_recorrencia TEXT NOT NULL CHECK (tipo_recorrencia IN ('especifico', 'semana_recorrente', 'diario_recorrente')),
            valor TEXT NOT NULL,
            hora_inicio TEXT,
            hora_fim TEXT,
            motivo TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((owner_space_id IS NOT NULL AND employee_id IS NULL)
                OR (owner_space_id IS NULL AND employee_id IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS saas_schedule_blocks_owner_idx
            ON saas_schedule_blocks(owner_space_id);
        CREATE INDEX IF NOT EXISTS saas_schedule_blocks_employee_idx
            ON saas_schedule_blocks(employee_id);
        CREATE TABLE IF NOT EXISTS saas_portal_sessions (
            token_hash CHAR(64) PRIMARY KEY,
            user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'employee')),
            user_id UUID NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_portal_sessions_user_idx
            ON saas_portal_sessions(user_type, user_id);
        CREATE TABLE IF NOT EXISTS saas_customer_favorites (
            customer_id UUID NOT NULL REFERENCES saas_customers(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (customer_id, space_id)
        );
        CREATE TABLE IF NOT EXISTS saas_customer_recent_spaces (
            customer_id UUID NOT NULL REFERENCES saas_customers(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            last_visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (customer_id, space_id)
        );
        ALTER TABLE agendamentos
            ADD COLUMN IF NOT EXISTS saas_cliente_id UUID REFERENCES saas_customers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS saas_professional_type TEXT,
            ADD COLUMN IF NOT EXISTS saas_professional_id UUID;
        DO $saas$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'agendamentos'
                  AND column_name = 'cliente_id'
                  AND data_type = 'uuid'
            ) THEN
                EXECUTE '
                    UPDATE agendamentos a
                    SET saas_cliente_id = a.cliente_id
                    FROM saas_customers c
                    WHERE c.id = a.cliente_id AND a.saas_cliente_id IS NULL
                ';
            END IF;
        END
        $saas$;
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

function serializeSessionCookie(token, env = process.env, remember = true) {
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    const persistence = remember ? `; Max-Age=${maxAge}` : '';
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${persistence}${secure}`;
}

function isValidEmail(email) {
    return typeof email === 'string'
        && email.length <= 254
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidOptionalImageUrl(value) {
    if (value === '' || value === null || value === undefined) return true;
    if (typeof value !== 'string' || value.length > 2048) return false;

    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

function normalizeWhatsAppPhone(value) {
    if (typeof value !== 'string' || value.length > 30) return null;
    const compact = value.trim().replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{7,14}$/.test(compact)) return null;
    return compact.replace(/^\+/, '');
}

async function sendWhatsAppTemplate(phone, templateName, parameters) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION;
    if (!accessToken || !phoneNumberId || !apiVersion || !/^v\d+\.\d+$/.test(apiVersion)
        || !/^\d+$/.test(phoneNumberId) || !templateName) {
        return { status: 'not_configured' };
    }

    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
                name: templateName,
                language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR' },
                components: parameters.length
                    ? [{
                        type: 'body',
                        parameters: parameters.map((text) => ({ type: 'text', text }))
                    }]
                    : []
            }
        })
    });

    if (!response.ok) {
        console.error('WhatsApp template delivery failed:', response.status);
        return { status: 'failed' };
    }
    return { status: 'sent' };
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
    const nextPaymentAt = subscription.next_payment_at ? new Date(subscription.next_payment_at) : null;
    const paymentIsOverdue = providerStatus === 'authorized'
        && nextPaymentAt
        && !Number.isNaN(nextPaymentAt.getTime())
        && nextPaymentAt <= now;
    let status = providerStatus;

    if (paymentIsOverdue) status = 'payment_overdue';
    else if (providerStatus === 'authorized') status = 'active';
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
                return await handler(req, res, next);
            } catch (error) {
                console.error('SaaS account request failed:', error);
                const timedOut = ['57014', '55P03', 'ETIMEDOUT'].includes(error.code)
                    || /timeout/i.test(error.message || '');
                return res.status(timedOut ? 503 : 500).json({
                    error: timedOut
                        ? 'O banco de dados demorou para responder. Tente novamente em instantes.'
                        : 'Não foi possível validar sua conta.'
                });
            }
        };
    }

    function requireOwnedSpace(handler) {
        return async (req, res, next) => {
            const startedAt = Date.now();
            let phase = 'schema';
            try {
                await ensureSchema();
                phase = 'owner_session';
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
                console.info('Owner space authorized:', {
                    space_id: req.params.id,
                    duration_ms: Date.now() - startedAt
                });
                return await handler(req, res, next);
            } catch (error) {
                console.error('SaaS establishment authorization failed:', {
                    space_id: req.params.id,
                    phase,
                    duration_ms: Date.now() - startedAt,
                    code: error.code,
                    message: error.message
                });
                const timedOut = ['57014', '55P03', 'ETIMEDOUT'].includes(error.code)
                    || /timeout/i.test(error.message || '');
                return res.status(timedOut ? 503 : 500).json({
                    error: timedOut
                        ? 'O banco de dados demorou para responder. Tente novamente em instantes.'
                        : 'Não foi possível validar o estabelecimento.'
                });
            }
        };
    }

    async function createSession(accountId, res, remember = true) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query(`
            INSERT INTO saas_sessions (token_hash, account_id, expires_at)
            VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'))
        `, [tokenHash, accountId, SESSION_DAYS]);
        res.setHeader('Set-Cookie', serializeSessionCookie(token, process.env, remember));
    }

    async function createPortalSession(userType, userId, res, remember = true) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query(`
            INSERT INTO saas_portal_sessions (token_hash, user_type, user_id, expires_at)
            VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 day'))
        `, [tokenHash, userType, userId, SESSION_DAYS]);
        res.setHeader('Set-Cookie', serializeSessionCookie(token, process.env, remember));
    }

    async function getPortalUser(req, userType) {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!token || !/^[\da-f]{64}$/i.test(token)) return null;
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const result = await pool.query(`
            SELECT user_id
            FROM saas_portal_sessions
            WHERE token_hash = $1 AND user_type = $2 AND expires_at > NOW()
        `, [tokenHash, userType]);
        return result.rows[0]?.user_id || null;
    }

    function requirePortalUser(userType, handler) {
        return async (req, res, next) => {
            try {
                await ensureSchema();
                const userId = await getPortalUser(req, userType);
                if (!userId) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
                req.portalUserId = userId;
                return await handler(req, res, next);
            } catch (error) {
                console.error(`${userType} portal request failed:`, error);
                return res.status(500).json({ error: 'Não foi possível validar sua conta.' });
            }
        };
    }

    function scheduleBlockFromRow(row) {
                return {
                    id: row.id,
                    tipoAlvo: row.tipo_alvo,
                    tipoRecorrencia: row.tipo_recorrencia,
                    valor: row.valor,
                    horaInicio: row.hora_inicio,
                    horaFim: row.hora_fim,
                    motivo: row.motivo,
                    spaceId: row.owner_space_id,
                    storeName: row.store_name || null,
                    scope: row.owner_space_id ? 'store' : 'employee'
                };
            }

            async function saveScheduleBlock({ id, spaceId = null, employeeId = null, block }) {
                await pool.query(`
                    INSERT INTO saas_schedule_blocks
                        (id, owner_space_id, employee_id, tipo_alvo, tipo_recorrencia, valor, hora_inicio, hora_fim, motivo)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET
                        tipo_alvo = EXCLUDED.tipo_alvo,
                        tipo_recorrencia = EXCLUDED.tipo_recorrencia,
                        valor = EXCLUDED.valor,
                        hora_inicio = EXCLUDED.hora_inicio,
                        hora_fim = EXCLUDED.hora_fim,
                        motivo = EXCLUDED.motivo
                    WHERE saas_schedule_blocks.owner_space_id IS NOT DISTINCT FROM EXCLUDED.owner_space_id
                      AND saas_schedule_blocks.employee_id IS NOT DISTINCT FROM EXCLUDED.employee_id
                `, [
                    id,
                    spaceId,
                    employeeId,
                    block.tipoAlvo,
                    block.tipoRecorrencia,
                    String(block.valor),
                    block.horaInicio || null,
                    block.horaFim || null,
                    block.motivo.trim()
                ]);
            }

            async function getScheduleBlocksForSpace(spaceId, employeeId = null, executor = pool) {
                await ensureSchema();
                const result = await executor.query(`
                    SELECT b.id, b.owner_space_id, b.employee_id, b.tipo_alvo, b.tipo_recorrencia,
                           b.valor, b.hora_inicio, b.hora_fim, b.motivo, e.nome AS store_name
                    FROM saas_schedule_blocks b
                    LEFT JOIN espacos e ON e.id = b.owner_space_id
                    WHERE b.owner_space_id = $1 OR ($2::uuid IS NOT NULL AND b.employee_id = $2::uuid)
                    ORDER BY b.created_at, b.id
                `, [spaceId, employeeId]);
                return result.rows.map(scheduleBlockFromRow);
            }

            app.get('/api/saas/spaces/:id/schedule', requireOwnedSpace(async (req, res) => {
                const [hoursResult, blocksResult] = await Promise.all([
                    pool.query(`
                        SELECT dia_semana, hora_inicio, hora_fim, ativo
                        FROM configuracoes_horarios
                        WHERE espaco_id = $1
                        ORDER BY dia_semana
                    `, [req.params.id]),
                    pool.query(`
                        SELECT id, tipo_alvo, tipo_recorrencia, valor, hora_inicio, hora_fim, motivo
                        FROM saas_schedule_blocks
                        WHERE owner_space_id = $1
                        ORDER BY created_at, id
                    `, [req.params.id])
                ]);
                return res.json({
                    hours: hoursResult.rows,
                    blocks: blocksResult.rows.map(scheduleBlockFromRow)
                });
            }));

            if (typeof app.put === 'function') app.put('/api/saas/spaces/:id/schedule/hours', requireOwnedSpace(async (req, res) => {
                const { hours } = req.body || {};
                const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
                if (!Array.isArray(hours) || hours.length !== 7
                    || hours.some((day, index) => !day || Number(day.dia_semana) !== index
                        || typeof day.ativo !== 'boolean'
                        || (day.ativo && (!timePattern.test(day.hora_inicio || '')
                            || !timePattern.test(day.hora_fim || '')
                            || day.hora_inicio >= day.hora_fim)))) {
                    return res.status(400).json({ error: 'Informe horários válidos para os sete dias da semana.' });
                }

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM configuracoes_horarios WHERE espaco_id = $1', [req.params.id]);
                    for (const day of hours) {
                        await client.query(`
                            INSERT INTO configuracoes_horarios (espaco_id, dia_semana, hora_inicio, hora_fim, ativo)
                            VALUES ($1, $2, $3, $4, $5)
                        `, [
                            req.params.id,
                            day.dia_semana,
                            day.ativo ? day.hora_inicio : '00:00',
                            day.ativo ? day.hora_fim : '00:00',
                            day.ativo
                        ]);
                    }
                    await client.query('COMMIT');
                    return res.json({ message: 'Expediente salvo.' });
                } catch (error) {
                    await client.query('ROLLBACK').catch((rollbackError) => console.error('Schedule hours rollback failed:', rollbackError));
                    console.error('Store schedule hours update failed:', error);
                    return res.status(500).json({ error: 'Não foi possível salvar o expediente.' });
                } finally {
                    client.release();
                }
            }));

            app.post('/api/saas/spaces/:id/schedule/blocks', requireOwnedSpace(async (req, res) => {
                const block = req.body || {};
                if (!isValidScheduleBlock(block)) {
                    return res.status(400).json({ error: 'Informe um bloqueio válido.' });
                }
                try {
                    const id = crypto.randomUUID();
                    await saveScheduleBlock({ id, spaceId: req.params.id, block });
                    return res.status(201).json({ block: { ...block, id, scope: 'store', spaceId: Number(req.params.id) } });
                } catch (error) {
                    console.error('Store schedule block creation failed:', error);
                    return res.status(500).json({ error: 'Não foi possível salvar o bloqueio.' });
                }
            }));

            app.patch('/api/saas/spaces/:id/schedule/blocks/:blockId', requireOwnedSpace(async (req, res) => {
                const block = req.body || {};
                if (!/^[\da-f-]{36}$/i.test(req.params.blockId) || !isValidScheduleBlock(block)) {
                    return res.status(400).json({ error: 'Informe um bloqueio válido.' });
                }
                try {
                    const result = await pool.query(`
                        UPDATE saas_schedule_blocks
                        SET tipo_alvo = $1, tipo_recorrencia = $2, valor = $3, hora_inicio = $4, hora_fim = $5, motivo = $6
                        WHERE id = $7 AND owner_space_id = $8
                        RETURNING id
                    `, [
                        block.tipoAlvo, block.tipoRecorrencia, String(block.valor),
                        block.horaInicio || null, block.horaFim || null, block.motivo.trim(),
                        req.params.blockId, req.params.id
                    ]);
                    if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio não encontrado.' });
                    return res.json({ block: { ...block, id: req.params.blockId, scope: 'store', spaceId: Number(req.params.id) } });
                } catch (error) {
                    console.error('Store schedule block update failed:', error);
                    return res.status(500).json({ error: 'Não foi possível atualizar o bloqueio.' });
                }
            }));

            app.delete('/api/saas/spaces/:id/schedule/blocks/:blockId', requireOwnedSpace(async (req, res) => {
                try {
                    const result = await pool.query(
                        'DELETE FROM saas_schedule_blocks WHERE id = $1 AND owner_space_id = $2 RETURNING id',
                        [req.params.blockId, req.params.id]
                    );
                    if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio não encontrado.' });
                    return res.status(204).end();
                } catch (error) {
                    console.error('Store schedule block removal failed:', error);
                    return res.status(500).json({ error: 'Não foi possível remover o bloqueio.' });
                }
            }));

            app.get('/api/employee/schedule', requirePortalUser('employee', async (req, res) => {
                const spacesResult = await pool.query(`
                    SELECT e.id AS space_id, e.nome AS store_name
                    FROM saas_employee_spaces es
                    JOIN espacos e ON e.id = es.space_id
                    WHERE es.employee_id = $1
                    ORDER BY e.nome
                `, [req.portalUserId]);
                const spaceIds = spacesResult.rows.map((space) => Number(space.space_id));
                if (!spaceIds.length) return res.json({ blocks: [], appointments: [] });
                const requestedSpace = req.query.space_id;
                if (requestedSpace && (!/^\d+$/.test(requestedSpace) || !spaceIds.includes(Number(requestedSpace)))) {
                    return res.status(403).json({ error: 'Esta empresa não está vinculada à sua conta.' });
                }
                const filteredSpaceIds = requestedSpace ? [Number(requestedSpace)] : spaceIds;
                const [blocksResult, appointmentsResult] = await Promise.all([
                    pool.query(`
                        SELECT b.id, b.owner_space_id, b.employee_id, b.tipo_alvo, b.tipo_recorrencia,
                               b.valor, b.hora_inicio, b.hora_fim, b.motivo, e.nome AS store_name
                        FROM saas_schedule_blocks b
                        LEFT JOIN espacos e ON e.id = b.owner_space_id
                        WHERE b.employee_id = $1 OR b.owner_space_id = ANY($2::integer[])
                        ORDER BY b.created_at, b.id
                    `, [req.portalUserId, spaceIds]),
                    pool.query(`
                        SELECT a.id, a.espaco_id AS space_id, e.nome AS store_name,
                               a.data_hora_inicio::date::text AS local_date,
                               to_char(a.data_hora_inicio, 'HH24:MI') AS local_time,
                               a.cliente_nome, a.cliente_telefone, a.status,
                               s.nome AS service_name, s.preco AS service_price
                        FROM agendamentos a
                        JOIN espacos e ON e.id = a.espaco_id
                        LEFT JOIN servicos s ON s.id = a.servico_id
                        WHERE a.espaco_id = ANY($1::integer[])
                          AND a.saas_professional_type = 'employee'
                          AND a.saas_professional_id = $2
                          AND a.status IN ('confirmado', 'agendado', 'pago')
                        ORDER BY a.data_hora_inicio
                    `, [filteredSpaceIds, req.portalUserId])
                ]);
                return res.json({
                    blocks: blocksResult.rows.map(scheduleBlockFromRow),
                    appointments: appointmentsResult.rows.map((appointment) => ({
                        id: appointment.id,
                        space_id: Number(appointment.space_id),
                        store_name: appointment.store_name,
                        data: appointment.local_date,
                        hora: appointment.local_time,
                        cliente: appointment.cliente_nome,
                        telefone: appointment.cliente_telefone,
                        status: appointment.status === 'pago' ? 'pago' : 'agendado',
                        servico: appointment.service_name || 'Serviço',
                        valor: Number(appointment.service_price) || 0
                    }))
                });
            }));

            app.post('/api/employee/schedule/blocks', requirePortalUser('employee', async (req, res) => {
                const block = req.body || {};
                if (!isValidScheduleBlock(block)) return res.status(400).json({ error: 'Informe um bloqueio válido.' });
                try {
                    const id = crypto.randomUUID();
                    await saveScheduleBlock({ id, employeeId: req.portalUserId, block });
                    return res.status(201).json({ block: { ...block, id, scope: 'employee' } });
                } catch (error) {
                    console.error('Employee schedule block creation failed:', error);
                    return res.status(500).json({ error: 'Não foi possível salvar seu bloqueio.' });
                }
            }));

            app.patch('/api/employee/schedule/blocks/:blockId', requirePortalUser('employee', async (req, res) => {
                const block = req.body || {};
                if (!/^[\da-f-]{36}$/i.test(req.params.blockId) || !isValidScheduleBlock(block)) {
                    return res.status(400).json({ error: 'Informe um bloqueio válido.' });
                }
                try {
                    const result = await pool.query(`
                        UPDATE saas_schedule_blocks
                        SET tipo_alvo = $1, tipo_recorrencia = $2, valor = $3, hora_inicio = $4, hora_fim = $5, motivo = $6
                        WHERE id = $7 AND employee_id = $8
                        RETURNING id
                    `, [
                        block.tipoAlvo, block.tipoRecorrencia, String(block.valor),
                        block.horaInicio || null, block.horaFim || null, block.motivo.trim(),
                        req.params.blockId, req.portalUserId
                    ]);
                    if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio pessoal não encontrado.' });
                    return res.json({ block: { ...block, id: req.params.blockId, scope: 'employee' } });
                } catch (error) {
                    console.error('Employee schedule block update failed:', error);
                    return res.status(500).json({ error: 'Não foi possível atualizar seu bloqueio.' });
                }
            }));

            app.delete('/api/employee/schedule/blocks/:blockId', requirePortalUser('employee', async (req, res) => {
                try {
                    const result = await pool.query(
                        'DELETE FROM saas_schedule_blocks WHERE id = $1 AND employee_id = $2 RETURNING id',
                        [req.params.blockId, req.portalUserId]
                    );
                    if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio pessoal não encontrado.' });
                    return res.status(204).end();
                } catch (error) {
                    console.error('Employee schedule block removal failed:', error);
                    return res.status(500).json({ error: 'Não foi possível remover seu bloqueio.' });
                }
            }));

    async function getCustomerForRequest(req) {
        await ensureSchema();
        const customerId = await getPortalUser(req, 'customer');
        if (!customerId) return null;
        const result = await pool.query(
            'SELECT id, full_name, email, phone FROM saas_customers WHERE id = $1',
            [customerId]
        );
        return result.rows[0] || null;
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

    app.post('/api/customer/register', async (req, res) => {
        const { nome, email, telefone, senha, remember } = req.body || {};
        const phone = normalizeWhatsAppPhone(telefone);
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
            return res.status(400).json({ error: 'Informe seu nome completo.' });
        }
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        if (!phone) return res.status(400).json({ error: 'Informe um telefone válido com código do país.' });
        if (typeof senha !== 'string' || senha.length < 10 || senha.length > 200) {
            return res.status(400).json({ error: 'A senha deve ter pelo menos 10 caracteres.' });
        }

        try {
            await ensureSchema();
            const customerId = crypto.randomUUID();
            await pool.query(`
                INSERT INTO saas_customers (id, full_name, email, phone, password_hash)
                VALUES ($1, $2, $3, $4, $5)
            `, [customerId, nome.trim(), email.trim().toLowerCase(), phone, hashPassword(senha)]);
            await createPortalSession('customer', customerId, res, remember !== false);
            return res.status(201).json({ message: 'Conta criada.', next: '/cliente.html' });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'Já existe uma conta de cliente com este e-mail.' });
            }
            console.error('Customer registration failed:', error);
            return res.status(500).json({ error: 'Não foi possível criar a conta de cliente.' });
        }
    });

    app.post('/api/customer/login', async (req, res) => {
        const { email, senha, remember } = req.body || {};
        if (!isValidEmail(email) || typeof senha !== 'string' || senha.length > 200) {
            return res.status(400).json({ error: 'Informe um e-mail e uma senha válidos.' });
        }
        try {
            await ensureSchema();
            const result = await pool.query(
                'SELECT id, password_hash FROM saas_customers WHERE email = $1',
                [email.trim().toLowerCase()]
            );
            const customer = result.rows[0];
            if (!customer || !verifyPassword(senha, customer.password_hash)) {
                return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
            }
            await createPortalSession('customer', customer.id, res, remember !== false);
            return res.json({ message: 'Sessão iniciada.', next: '/cliente.html' });
        } catch (error) {
            console.error('Customer login failed:', error);
            return res.status(500).json({ error: 'Não foi possível entrar na conta de cliente.' });
        }
    });

    app.post('/api/employee/register', async (req, res) => {
        const { nome, email, senha, remember } = req.body || {};
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
            return res.status(400).json({ error: 'Informe seu nome completo.' });
        }
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        if (typeof senha !== 'string' || senha.length < 10 || senha.length > 200) {
            return res.status(400).json({ error: 'A senha deve ter pelo menos 10 caracteres.' });
        }
        const client = await pool.connect();
        try {
            await ensureSchema();
            const employeeId = crypto.randomUUID();
            await client.query('BEGIN');
            await client.query(`
                INSERT INTO saas_employees (id, full_name, email, password_hash)
                VALUES ($1, $2, $3, $4)
            `, [employeeId, nome.trim(), email.trim().toLowerCase(), hashPassword(senha)]);

            await client.query('COMMIT');
            await createPortalSession('employee', employeeId, res, remember !== false);
            return res.status(201).json({
                message: 'Conta criada.',
                next: '/colaborador.html?aba=perfil&vincular=1'
            });
        } catch (error) {
            await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Employee registration rollback failed:', rollbackError);
            });
            if (error.code === '23505') {
                return res.status(409).json({ error: 'Já existe uma conta de funcionário com este e-mail.' });
            }
            console.error('Employee registration failed:', error);
            return res.status(500).json({ error: 'Não foi possível criar a conta de funcionário.' });
        } finally {
            client.release();
        }
    });

    app.post('/api/employee/login', async (req, res) => {
        const { email, senha, remember } = req.body || {};
        if (!isValidEmail(email) || typeof senha !== 'string' || senha.length > 200) {
            return res.status(400).json({ error: 'Informe um e-mail e uma senha válidos.' });
        }
        try {
            await ensureSchema();
            const result = await pool.query(
                'SELECT id, password_hash FROM saas_employees WHERE email = $1',
                [email.trim().toLowerCase()]
            );
            const employee = result.rows[0];
            if (!employee || !verifyPassword(senha, employee.password_hash)) {
                return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
            }
            await createPortalSession('employee', employee.id, res, remember !== false);
            return res.json({ message: 'Sessão iniciada.', next: '/colaborador.html' });
        } catch (error) {
            console.error('Employee login failed:', error);
            return res.status(500).json({ error: 'Não foi possível entrar na conta de funcionário.' });
        }
    });

    app.post('/api/saas/register', async (req, res) => {
        const { nome, email, senha, telefone_whatsapp, consentimento_whatsapp, nome_loja, segmento } = req.body || {};
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
            return res.status(400).json({ error: 'Informe seu nome completo.' });
        }
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        if (typeof senha !== 'string' || senha.length < 10 || senha.length > 200) {
            return res.status(400).json({ error: 'A senha deve ter pelo menos 10 caracteres.' });
        }
        const whatsappPhone = normalizeWhatsAppPhone(telefone_whatsapp);
        if (!whatsappPhone) {
            return res.status(400).json({ error: 'Informe um WhatsApp válido com código do país, por exemplo +55 11 99999-9999.' });
        }
        if (consentimento_whatsapp !== true) {
            return res.status(400).json({ error: 'Autorize o envio de avisos da conta pelo WhatsApp para continuar.' });
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
                    INSERT INTO saas_accounts
                        (id, space_id, full_name, email, whatsapp_phone, whatsapp_opt_in_at, password_hash, store_name, store_segment)
                    VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
                `, [
                    accountId,
                    spaceId,
                    nome.trim(),
                    normalizedEmail,
                    whatsappPhone,
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

            await createSession(accountId, res, req.body?.remember !== false);
            let whatsappStatus = 'not_configured';
            try {
                const notification = await sendWhatsAppTemplate(
                    whatsappPhone,
                    process.env.WHATSAPP_TEMPLATE_ACCOUNT_CREATED,
                    [nome.trim()]
                );
                whatsappStatus = notification.status;
            } catch (error) {
                whatsappStatus = 'failed';
                console.error('WhatsApp account-created notification failed:', error);
            }
            res.status(201).json({
                message: 'Conta criada.',
                whatsapp_notification: whatsappStatus,
                next: plan.trialDays > 0 ? '/admin.html' : '/assinatura.html'
            });
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
                SELECT a.id, a.password_hash, a.space_id,
                       s.provider_status, s.amount_brl, s.trial_days,
                       s.trial_ends_at, s.next_payment_at, s.checkout_url
                FROM saas_accounts a
                LEFT JOIN saas_subscriptions s ON s.account_id = a.id
                WHERE a.email = $1
            `, [email.trim().toLowerCase()]);
            const account = result.rows[0];
            if (!account || !verifyPassword(senha, account.password_hash)) {
                return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
            }
            await createSession(account.id, res, req.body?.remember !== false);
            const subscription = effectiveSubscription(account);
            const next = subscription.can_access && account.space_id
                ? '/admin.html'
                : '/assinatura.html';
            res.json({ message: 'Sessão iniciada.', next });
        } catch (error) {
            console.error('SaaS login failed:', error);
            res.status(500).json({ error: 'Não foi possível entrar na conta.' });
        }
    });

    app.post('/api/saas/request-password-reset', async (req, res) => {
        const { email } = req.body || {};
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });

        const appBaseUrl = process.env.APP_BASE_URL;
        const whatsAppReady = process.env.WHATSAPP_ACCESS_TOKEN
            && process.env.WHATSAPP_PHONE_NUMBER_ID
            && process.env.WHATSAPP_API_VERSION
            && /^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION)
            && process.env.WHATSAPP_TEMPLATE_PASSWORD_RESET;
        if (!whatsAppReady || !appBaseUrl) {
            return res.status(503).json({ error: 'A recuperação pelo WhatsApp ainda não está configurada.' });
        }

        let resetTokenHash;
        try {
            const baseUrl = new URL(appBaseUrl);
            if (!['http:', 'https:'].includes(baseUrl.protocol)
                || (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')) {
                return res.status(503).json({ error: 'A URL pública para recuperação de senha não está configurada corretamente.' });
            }

            await ensureSchema();
            const normalizedEmail = email.trim().toLowerCase();
            const accountResult = await pool.query(
                'SELECT id, full_name, whatsapp_phone FROM saas_accounts WHERE email = $1',
                [normalizedEmail]
            );
            const account = accountResult.rows[0];
            const genericMessage = 'Se os dados corresponderem a uma conta, enviaremos as instruções para o WhatsApp cadastrado.';
            if (!account || !account.whatsapp_phone) {
                return res.json({ message: genericMessage });
            }

            const recentRequest = await pool.query(`
                SELECT EXISTS (
                    SELECT 1 FROM saas_password_resets
                    WHERE account_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
                ) AS requested_recently
            `, [account.id]);
            if (recentRequest.rows[0]?.requested_recently) {
                return res.json({ message: genericMessage });
            }

            const resetToken = crypto.randomBytes(32).toString('hex');
            resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
            await pool.query(`
                DELETE FROM saas_password_resets
                WHERE expires_at <= NOW() OR created_at < NOW() - INTERVAL '1 day'
            `);
            await pool.query(`
                INSERT INTO saas_password_resets (token_hash, account_id, expires_at)
                VALUES ($1, $2, NOW() + INTERVAL '30 minutes')
            `, [resetTokenHash, account.id]);

            const resetUrl = new URL('/recuperar-senha.html', baseUrl);
            resetUrl.hash = new URLSearchParams({ token: resetToken }).toString();
            let delivery;
            try {
                delivery = await sendWhatsAppTemplate(
                    account.whatsapp_phone,
                    process.env.WHATSAPP_TEMPLATE_PASSWORD_RESET,
                    [account.full_name, resetUrl.href]
                );
            } catch (error) {
                console.error('Password reset WhatsApp delivery failed:', error);
                delivery = { status: 'failed' };
            }
            if (delivery.status !== 'sent') {
                console.error('Password reset WhatsApp delivery was not sent:', delivery.status);
                await pool.query('DELETE FROM saas_password_resets WHERE token_hash = $1', [resetTokenHash]);
            }
            return res.json({ message: genericMessage });
        } catch (error) {
            if (resetTokenHash) {
                await pool.query('DELETE FROM saas_password_resets WHERE token_hash = $1', [resetTokenHash])
                    .catch((cleanupError) => console.error('Password reset token cleanup failed:', cleanupError));
            }
            console.error('Password reset request failed:', error);
            return res.status(500).json({ error: 'Não foi possível processar a solicitação de recuperação.' });
        }
    });

    app.post('/api/saas/admin/password-reset-link', async (req, res) => {
        const adminKey = process.env.PASSWORD_RESET_ADMIN_KEY;
        const suppliedKey = req.headers?.['x-password-reset-admin-key'];
        if (typeof adminKey !== 'string' || adminKey.length < 32) {
            return res.status(503).json({ error: 'A recuperação administrativa não está configurada.' });
        }
        if (typeof suppliedKey !== 'string') {
            return res.status(401).json({ error: 'Não autorizado.' });
        }
        const expectedKeyBuffer = Buffer.from(adminKey);
        const suppliedKeyBuffer = Buffer.from(suppliedKey);
        if (expectedKeyBuffer.length !== suppliedKeyBuffer.length
            || !crypto.timingSafeEqual(expectedKeyBuffer, suppliedKeyBuffer)) {
            return res.status(401).json({ error: 'Não autorizado.' });
        }

        const { email } = req.body || {};
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });

        let resetTokenHash;
        try {
            const appBaseUrl = process.env.APP_BASE_URL;
            if (!appBaseUrl) {
                return res.status(503).json({ error: 'A URL pública para recuperação de senha não está configurada.' });
            }
            const baseUrl = new URL(appBaseUrl);
            if (!['http:', 'https:'].includes(baseUrl.protocol)
                || (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')) {
                return res.status(503).json({ error: 'A URL pública para recuperação de senha não está configurada corretamente.' });
            }

            await ensureSchema();
            const accountResult = await pool.query(
                'SELECT id FROM saas_accounts WHERE email = $1',
                [email.trim().toLowerCase()]
            );
            const account = accountResult.rows[0];
            if (!account) return res.status(404).json({ error: 'Não existe conta cadastrada com esse e-mail.' });

            const resetToken = crypto.randomBytes(32).toString('hex');
            resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
            await pool.query(`
                UPDATE saas_password_resets
                SET used_at = NOW()
                WHERE account_id = $1 AND used_at IS NULL
            `, [account.id]);
            await pool.query(`
                INSERT INTO saas_password_resets (token_hash, account_id, expires_at)
                VALUES ($1, $2, NOW() + INTERVAL '30 minutes')
            `, [resetTokenHash, account.id]);

            const resetUrl = new URL('/recuperar-senha.html', baseUrl);
            resetUrl.hash = new URLSearchParams({ token: resetToken }).toString();
            return res.json({
                message: 'Link de recuperação gerado. Confirme a identidade do usuário antes de compartilhá-lo.',
                reset_url: resetUrl.href,
                expires_in_minutes: 30
            });
        } catch (error) {
            if (resetTokenHash) {
                await pool.query('DELETE FROM saas_password_resets WHERE token_hash = $1', [resetTokenHash])
                    .catch((cleanupError) => console.error('Administrative password reset cleanup failed:', cleanupError));
            }
            console.error('Administrative password reset link generation failed:', error);
            return res.status(500).json({ error: 'Não foi possível gerar o link de recuperação.' });
        }
    });

    app.post('/api/saas/reset-password', async (req, res) => {
        const { token, senha } = req.body || {};
        if (typeof token !== 'string' || !/^[\da-f]{64}$/i.test(token)) {
            return res.status(400).json({ error: 'O link de recuperação é inválido ou expirou.' });
        }
        if (typeof senha !== 'string' || senha.length < 10 || senha.length > 200) {
            return res.status(400).json({ error: 'A nova senha deve ter pelo menos 10 caracteres.' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        let client;
        try {
            await ensureSchema();
            client = await pool.connect();
            await client.query('BEGIN');
            const tokenResult = await client.query(`
                SELECT account_id
                FROM saas_password_resets
                WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
                FOR UPDATE
            `, [tokenHash]);
            const reset = tokenResult.rows[0];
            if (!reset) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'O link de recuperação é inválido ou expirou.' });
            }

            await client.query(
                'UPDATE saas_accounts SET password_hash = $1 WHERE id = $2',
                [hashPassword(senha), reset.account_id]
            );
            await client.query(
                'UPDATE saas_password_resets SET used_at = NOW() WHERE token_hash = $1',
                [tokenHash]
            );
            await client.query('DELETE FROM saas_sessions WHERE account_id = $1', [reset.account_id]);
            await client.query('COMMIT');
            return res.json({ message: 'Senha alterada. Entre novamente com a nova senha.' });
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch((rollbackError) => {
                    console.error('Password reset rollback failed:', rollbackError);
                });
            }
            console.error('Password reset failed:', error);
            return res.status(500).json({ error: 'Não foi possível alterar a senha.' });
        } finally {
            if (client) client.release();
        }
    });

    app.post('/api/saas/logout', async (req, res) => {
        try {
            const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
            if (token && /^[\da-f]{64}$/i.test(token)) {
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                await ensureSchema();
                await pool.query('DELETE FROM saas_sessions WHERE token_hash = $1', [tokenHash]);
                await pool.query('DELETE FROM saas_portal_sessions WHERE token_hash = $1', [tokenHash]);
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

    app.post('/api/saas/employee-code', requireAccount(async (req, res) => {
        const account = req.saasAccount;
        if (!account.space_id) return res.status(403).json({ error: 'Sua conta não possui um estabelecimento vinculado.' });
        if (!effectiveSubscription(account).can_access) {
            return res.status(402).json({ error: 'Sua assinatura não está ativa.' });
        }

        try {
            const code = crypto.randomBytes(6).toString('hex').toUpperCase();
            const codeHash = crypto.createHash('sha256').update(code).digest('hex');
            await pool.query(`
                INSERT INTO saas_employee_codes (space_id, created_by, code_hash, created_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (space_id) DO UPDATE SET
                    created_by = EXCLUDED.created_by,
                    code_hash = EXCLUDED.code_hash,
                    created_at = NOW()
            `, [account.space_id, account.id, codeHash]);
            return res.json({ code, message: 'Código criado. Ele substitui o código anterior desta loja.' });
        } catch (error) {
            console.error('Employee company-code creation failed:', error);
            return res.status(500).json({ error: 'Não foi possível gerar o código da empresa.' });
        }
    }));

    app.get('/api/saas/employees', requireAccount(async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT e.id, e.full_name, e.email, es.linked_at, es.company_percentage
                FROM saas_employee_spaces es
                JOIN saas_employees e ON e.id = es.employee_id
                WHERE es.space_id = $1
                ORDER BY e.full_name
            `, [req.saasAccount.space_id]);
            return res.json(result.rows);
        } catch (error) {
            console.error('Employee list retrieval failed:', error);
            return res.status(500).json({ error: 'Não foi possível carregar a equipe vinculada.' });
        }
    }));

    async function readServicesForSpace(spaceId) {
        const [servicesResult, professionalsResult] = await Promise.all([
            pool.query(`
                SELECT id, nome, categoria, duracao_minutos, preco
                FROM servicos
                WHERE espaco_id = $1
                ORDER BY nome
            `, [spaceId]),
            pool.query(`
                SELECT sp.service_id, sp.professional_id, sp.professional_type,
                       CASE
                           WHEN sp.professional_type = 'employee' THEN e.full_name
                           ELSE a.full_name
                       END AS professional_name
                FROM saas_service_professionals sp
                LEFT JOIN saas_employees e
                    ON sp.professional_type = 'employee' AND e.id = sp.professional_id
                LEFT JOIN saas_accounts a
                    ON sp.professional_type = 'owner' AND a.id = sp.professional_id
                WHERE sp.space_id = $1
                ORDER BY professional_name
            `, [spaceId])
        ]);
        const professionalsByService = new Map();
        professionalsResult.rows.forEach((professional) => {
            const serviceId = String(professional.service_id);
            if (!professionalsByService.has(serviceId)) professionalsByService.set(serviceId, []);
            professionalsByService.get(serviceId).push({
                id: professional.professional_id,
                type: professional.professional_type,
                nome: professional.professional_name
            });
        });
        return servicesResult.rows.map((service) => ({
            ...service,
            profissionais: professionalsByService.get(String(service.id)) || []
        }));
    }

    async function saveServiceProfessionals(client, spaceId, serviceId, professionalIds) {
        if (!Array.isArray(professionalIds) || professionalIds.length > 100
            || professionalIds.some((id) => typeof id !== 'string'
                || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))) {
            return { error: 'Selecione profissionais válidos para o serviço.' };
        }

        const uniqueIds = [...new Set(professionalIds.map((id) => id.toLowerCase()))];
        if (uniqueIds.length !== professionalIds.length) {
            return { error: 'Um profissional foi selecionado mais de uma vez.' };
        }
        const employeesResult = await client.query(`
            SELECT e.id
            FROM saas_employee_spaces es
            JOIN saas_employees e ON e.id = es.employee_id
            WHERE es.space_id = $1 AND e.id = ANY($2::uuid[])
        `, [spaceId, uniqueIds]);
        const employeeIds = new Set(employeesResult.rows.map((employee) => String(employee.id).toLowerCase()));
        const ownerResult = uniqueIds.length
            ? await client.query('SELECT id FROM saas_accounts WHERE space_id = $1 AND id = ANY($2::uuid[])', [spaceId, uniqueIds])
            : { rows: [] };
        const ownerIds = new Set(ownerResult.rows.map((owner) => String(owner.id).toLowerCase()));
        const validIds = new Set([...employeeIds, ...ownerIds]);
        if (uniqueIds.some((id) => !validIds.has(id))) {
            return { error: 'Um ou mais profissionais não pertencem a esta loja.' };
        }

        await client.query(
            'DELETE FROM saas_service_professionals WHERE space_id = $1 AND service_id = $2',
            [spaceId, String(serviceId)]
        );
        for (const id of uniqueIds) {
            const type = ownerIds.has(id) ? 'owner' : 'employee';
            await client.query(`
                INSERT INTO saas_service_professionals
                    (space_id, service_id, professional_type, professional_id)
                VALUES ($1, $2, $3, $4)
            `, [spaceId, String(serviceId), type, id]);
        }
        return null;
    }

    app.get('/api/saas/spaces/:id/services', requireOwnedSpace(async (req, res) => {
        try {
            return res.json(await readServicesForSpace(req.saasAccount.space_id));
        } catch (error) {
            console.error('Owner service list retrieval failed:', error);
            return res.status(500).json({ error: 'Não foi possível carregar os serviços da loja.' });
        }
    }));

    app.post('/api/saas/spaces/:id/services', requireOwnedSpace(async (req, res) => {
        const { nome, categoria, duracao_minutos: duration, preco, profissionais } = req.body || {};
        const price = Number(preco);
        const serviceDuration = Number(duration);
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 150
            || (categoria !== undefined && (typeof categoria !== 'string' || categoria.trim().length > 80))
            || !Number.isInteger(serviceDuration) || serviceDuration < 1 || serviceDuration > 1440
            || !Number.isFinite(price) || price < 0 || price > 1000000) {
            return res.status(400).json({ error: 'Informe nome, categoria, duração e preço válidos para o serviço.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const inserted = await client.query(`
                INSERT INTO servicos (espaco_id, nome, categoria, duracao_minutos, preco)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
            `, [
                req.saasAccount.space_id,
                nome.trim(),
                typeof categoria === 'string' && categoria.trim() ? categoria.trim() : 'Geral',
                serviceDuration,
                price
            ]);
            const serviceId = inserted.rows[0]?.id;
            if (serviceId === undefined) throw new Error('Service insert did not return an ID.');
            const assignmentError = await saveServiceProfessionals(
                client, req.saasAccount.space_id, serviceId, profissionais || []
            );
            if (assignmentError) {
                await client.query('ROLLBACK');
                return res.status(400).json(assignmentError);
            }
            await client.query('COMMIT');
            return res.status(201).json({ message: 'Serviço cadastrado.', id: serviceId });
        } catch (error) {
            await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Service creation rollback failed:', rollbackError);
            });
            console.error('Owner service creation failed:', error);
            return res.status(500).json({ error: 'Não foi possível cadastrar o serviço.' });
        } finally {
            client.release();
        }
    }));

    app.patch('/api/saas/spaces/:id/services/:serviceId', requireOwnedSpace(async (req, res) => {
        const { serviceId } = req.params;
        const { nome, categoria, duracao_minutos: duration, preco, profissionais } = req.body || {};
        const price = Number(preco);
        const serviceDuration = Number(duration);
        if (!/^\d+$/.test(serviceId || '')
            || typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 150
            || (categoria !== undefined && (typeof categoria !== 'string' || categoria.trim().length > 80))
            || !Number.isInteger(serviceDuration) || serviceDuration < 1 || serviceDuration > 1440
            || !Number.isFinite(price) || price < 0 || price > 1000000) {
            return res.status(400).json({ error: 'Informe nome, categoria, duração e preço válidos para o serviço.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const updated = await client.query(`
                UPDATE servicos
                SET nome = $1, categoria = $2, duracao_minutos = $3, preco = $4
                WHERE id = $5 AND espaco_id = $6
                RETURNING id
            `, [
                nome.trim(),
                typeof categoria === 'string' && categoria.trim() ? categoria.trim() : 'Geral',
                serviceDuration,
                price,
                serviceId,
                req.saasAccount.space_id
            ]);
            if (!updated.rows[0]) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Serviço não encontrado nesta loja.' });
            }
            const assignmentError = await saveServiceProfessionals(
                client, req.saasAccount.space_id, serviceId, profissionais || []
            );
            if (assignmentError) {
                await client.query('ROLLBACK');
                return res.status(400).json(assignmentError);
            }
            await client.query('COMMIT');
            return res.json({ message: 'Serviço atualizado.' });
        } catch (error) {
            await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Service update rollback failed:', rollbackError);
            });
            console.error('Owner service update failed:', error);
            return res.status(500).json({ error: 'Não foi possível atualizar o serviço.' });
        } finally {
            client.release();
        }
    }));

    app.delete('/api/saas/spaces/:id/services/:serviceId', requireOwnedSpace(async (req, res) => {
        if (!/^\d+$/.test(req.params.serviceId || '')) {
            return res.status(400).json({ error: 'Serviço inválido.' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                'DELETE FROM saas_service_professionals WHERE space_id = $1 AND service_id = $2',
                [req.saasAccount.space_id, req.params.serviceId]
            );
            const deleted = await client.query(
                'DELETE FROM servicos WHERE id = $1 AND espaco_id = $2 RETURNING id',
                [req.params.serviceId, req.saasAccount.space_id]
            );
            if (!deleted.rows[0]) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Serviço não encontrado nesta loja.' });
            }
            await client.query('COMMIT');
            return res.json({ message: 'Serviço excluído.' });
        } catch (error) {
            await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Service deletion rollback failed:', rollbackError);
            });
            console.error('Owner service deletion failed:', error);
            return res.status(500).json({ error: 'Não foi possível excluir o serviço.' });
        } finally {
            client.release();
        }
    }));

    app.patch('/api/saas/employees/:employeeId/commission', requireAccount(async (req, res) => {
        const { employeeId } = req.params;
        const percentage = req.body?.company_percentage;
        if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(employeeId || '')) {
            return res.status(400).json({ error: 'Funcionário inválido.' });
        }
        if (typeof percentage !== 'number' || !Number.isFinite(percentage)
            || percentage < 0 || percentage > 100 || Math.round(percentage * 100) !== percentage * 100) {
            return res.status(400).json({ error: 'Informe um percentual entre 0 e 100, com até duas casas decimais.' });
        }
        try {
            const result = await pool.query(`
                UPDATE saas_employee_spaces
                SET company_percentage = $1
                WHERE employee_id = $2 AND space_id = $3
                RETURNING employee_id, space_id, company_percentage
            `, [percentage, employeeId, req.saasAccount.space_id]);
            if (!result.rows[0]) return res.status(404).json({ error: 'Funcionário não vinculado a esta loja.' });
            return res.json({ commission: result.rows[0] });
        } catch (error) {
            console.error('Employee commission update failed:', error);
            return res.status(500).json({ error: 'Não foi possível salvar o percentual do funcionário.' });
        }
    }));

    app.get('/api/customer/me', requirePortalUser('customer', async (req, res) => {
        try {
            const [customerResult, favoritesResult, appointmentsResult, recentVisitsResult] = await Promise.all([
                pool.query(
                    'SELECT id, full_name, email, phone, photo_url FROM saas_customers WHERE id = $1',
                    [req.portalUserId]
                ),
                pool.query(`
                    SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                           COALESCE(e.nicho, 'outros') AS segmento, e.logo_url
                    FROM saas_customer_favorites f
                    JOIN espacos e ON e.id = f.space_id
                    WHERE f.customer_id = $1
                    ORDER BY f.created_at DESC
                `, [req.portalUserId]),
                pool.query(`
                    SELECT a.id, a.espaco_id AS space_id, e.nome AS store_name,
                           s.nome AS service_name, a.data_hora_inicio, a.data_hora_fim, a.status
                    FROM agendamentos a
                    JOIN espacos e ON e.id = a.espaco_id
                    LEFT JOIN servicos s ON s.id = a.servico_id
                    WHERE a.saas_cliente_id = $1
                    ORDER BY a.data_hora_inicio DESC
                `, [req.portalUserId]),
                pool.query(`
                    SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                           r.last_visited_at
                    FROM saas_customer_recent_spaces r
                    JOIN espacos e ON e.id = r.space_id
                    WHERE r.customer_id = $1
                    ORDER BY r.last_visited_at DESC
                    LIMIT 12
                `, [req.portalUserId])
            ]);
            if (!customerResult.rows[0]) return res.status(404).json({ error: 'Conta de cliente não encontrada.' });

            const appointments = appointmentsResult.rows;
            const upcoming = appointments.filter((appointment) =>
                new Date(appointment.data_hora_inicio) >= new Date()
                && !['cancelado', 'cancelada', 'concluido', 'concluído'].includes(String(appointment.status).toLowerCase())
            );
            const history = appointments.filter((appointment) => !upcoming.includes(appointment));
            return res.json({
                customer: customerResult.rows[0],
                favorites: favoritesResult.rows,
                recent_visits: recentVisitsResult.rows,
                upcoming,
                history
            });
        } catch (error) {
            console.error('Customer portal data retrieval failed:', error);
            const timedOut = ['57014', '55P03', 'ETIMEDOUT'].includes(error.code)
                || /timeout/i.test(error.message || '');
            return res.status(timedOut ? 503 : 500).json({
                error: timedOut
                    ? 'O banco de dados demorou para responder. Tente novamente em instantes.'
                    : 'Não foi possível carregar seus dados de cliente.'
            });
        }
    }));

    app.patch('/api/customer/profile', requirePortalUser('customer', async (req, res) => {
        const { nome, email, telefone, photo_url: photoUrl } = req.body || {};
        const phone = normalizeWhatsAppPhone(telefone);
        if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
            return res.status(400).json({ error: 'Informe seu nome completo.' });
        }
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        if (!phone) return res.status(400).json({ error: 'Informe um telefone válido com código do país.' });
        if (!isValidOptionalImageUrl(photoUrl)) {
            return res.status(400).json({ error: 'Informe um link de foto HTTP ou HTTPS válido.' });
        }
        try {
            const result = await pool.query(`
                UPDATE saas_customers
                SET full_name = $1, email = $2, phone = $3,
                    photo_url = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE photo_url END
                WHERE id = $6
                RETURNING id, full_name, email, phone, photo_url
            `, [nome.trim(), email.trim().toLowerCase(), phone, photoUrl !== undefined, photoUrl || null, req.portalUserId]);
            return res.json({ customer: result.rows[0] });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'Já existe uma conta de cliente com este e-mail.' });
            }
            console.error('Customer profile update failed:', error);
            return res.status(500).json({ error: 'Não foi possível atualizar seu perfil.' });
        }
    }));

    app.post('/api/customer/favorites', requirePortalUser('customer', async (req, res) => {
        const { space_id: spaceId } = req.body || {};
        if (!/^\d+$/.test(String(spaceId || '')) || Number(spaceId) < 1) {
            return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
        }
        try {
            const storeResult = await pool.query('SELECT id FROM espacos WHERE id = $1', [spaceId]);
            if (storeResult.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
            await pool.query(`
                INSERT INTO saas_customer_favorites (customer_id, space_id)
                VALUES ($1, $2)
                ON CONFLICT (customer_id, space_id) DO NOTHING
            `, [req.portalUserId, spaceId]);
            return res.status(201).json({ message: 'Estabelecimento adicionado aos favoritos.' });
        } catch (error) {
            console.error('Customer favorite creation failed:', error);
            return res.status(500).json({ error: 'Não foi possível salvar o favorito.' });
        }
    }));

    app.delete('/api/customer/favorites/:spaceId', requirePortalUser('customer', async (req, res) => {
        if (!/^\d+$/.test(req.params.spaceId)) {
            return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
        }
        try {
            await pool.query(
                'DELETE FROM saas_customer_favorites WHERE customer_id = $1 AND space_id = $2',
                [req.portalUserId, req.params.spaceId]
            );
            return res.json({ message: 'Estabelecimento removido dos favoritos.' });
        } catch (error) {
            console.error('Customer favorite deletion failed:', error);
            return res.status(500).json({ error: 'Não foi possível remover o favorito.' });
        }
    }));

    app.post('/api/customer/recent-visits', requirePortalUser('customer', async (req, res) => {
        const { space_id: spaceId } = req.body || {};
        if (!/^\d+$/.test(String(spaceId || '')) || Number(spaceId) < 1) {
            return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
        }
        try {
            const storeResult = await pool.query('SELECT id FROM espacos WHERE id = $1', [spaceId]);
            if (storeResult.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
            await pool.query(`
                INSERT INTO saas_customer_recent_spaces (customer_id, space_id, last_visited_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (customer_id, space_id)
                DO UPDATE SET last_visited_at = NOW()
            `, [req.portalUserId, spaceId]);
            return res.status(204).end();
        } catch (error) {
            console.error('Customer recent-store update failed:', error);
            return res.status(500).json({ error: 'Não foi possível registrar a visita.' });
        }
    }));

    app.get('/api/employee/me', requirePortalUser('employee', async (req, res) => {
        const [employeeResult, spacesResult] = await Promise.all([
            pool.query(
                'SELECT id, full_name, email, photo_url FROM saas_employees WHERE id = $1',
                [req.portalUserId]
            ),
            pool.query(`
                SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                       es.company_percentage,
                       s.provider_status, s.trial_ends_at, s.next_payment_at
                FROM saas_employee_spaces es
                JOIN espacos e ON e.id = es.space_id
                LEFT JOIN saas_accounts a ON a.space_id = es.space_id
                LEFT JOIN saas_subscriptions s ON s.account_id = a.id
                WHERE es.employee_id = $1
                ORDER BY e.nome
            `, [req.portalUserId])
        ]);
        return res.json({
            employee: employeeResult.rows[0],
            spaces: spacesResult.rows.map((space) => ({
                space_id: space.space_id,
                store_name: space.store_name,
                nicho: space.nicho,
                company_percentage: Number(space.company_percentage) || 0,
                can_access: effectiveSubscription(space).can_access
            }))
        });
    }));

    app.patch('/api/employee/profile', requirePortalUser('employee', async (req, res) => {
        const { photo_url: photoUrl } = req.body || {};
        if (!isValidOptionalImageUrl(photoUrl)) {
            return res.status(400).json({ error: 'Informe um link de foto HTTP ou HTTPS válido.' });
        }
        try {
            const result = await pool.query(`
                UPDATE saas_employees
                SET photo_url = NULLIF($1, '')
                WHERE id = $2
                RETURNING id, full_name, email, photo_url
            `, [photoUrl || '', req.portalUserId]);
            if (!result.rows[0]) return res.status(404).json({ error: 'Conta profissional não encontrada.' });
            return res.json({ employee: result.rows[0] });
        } catch (error) {
            console.error('Employee profile update failed:', error);
            return res.status(500).json({ error: 'Não foi possível atualizar sua foto de perfil.' });
        }
    }));

    app.post('/api/employee/join', requirePortalUser('employee', async (req, res) => {
        const { codigo_empresa: code } = req.body || {};
        if (typeof code !== 'string' || !/^[\da-f]{12}$/i.test(code.trim())) {
            return res.status(400).json({ error: 'Informe um código de empresa válido.' });
        }
        try {
            const codeHash = crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
            const companyResult = await pool.query(`
                SELECT c.space_id, s.provider_status, s.trial_ends_at, s.next_payment_at
                FROM saas_employee_codes c
                JOIN saas_accounts a ON a.id = c.created_by
                JOIN saas_subscriptions s ON s.account_id = a.id
                WHERE c.code_hash = $1
            `, [codeHash]);
            const company = companyResult.rows[0];
            if (!company) return res.status(404).json({ error: 'Código da empresa inválido ou desativado.' });
            if (!effectiveSubscription(company).can_access) {
                return res.status(402).json({ error: 'A assinatura desta empresa não está ativa.' });
            }
            const result = await pool.query(`
                INSERT INTO saas_employee_spaces (employee_id, space_id)
                VALUES ($1, $2)
                ON CONFLICT (employee_id, space_id) DO NOTHING
                RETURNING space_id
            `, [req.portalUserId, company.space_id]);
            if (result.rows.length === 0) {
                return res.status(409).json({ error: 'Você já está vinculado a esta empresa.' });
            }
            return res.status(201).json({ message: 'Vínculo com a empresa criado.' });
        } catch (error) {
            console.error('Employee company join failed:', error);
            return res.status(500).json({ error: 'Não foi possível vincular sua conta à empresa.' });
        }
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
            const subscription = effectiveSubscription(req.saasAccount);
            if (subscription.status === 'payment_overdue' && req.saasAccount.checkout_url) {
                return res.json({ checkout_url: req.saasAccount.checkout_url });
            }
            return res.status(409).json({
                error: subscription.status === 'payment_overdue'
                    ? 'O pagamento está vencido. Aguarde a atualização da cobrança e tente novamente.'
                    : 'Sua assinatura já está ativa.'
            });
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
                const reference = crypto.randomUUID();
                const causes = Array.isArray(payload.cause)
                    ? payload.cause.map(({ code, description }) => ({ code, description }))
                    : [];
                console.error('Mercado Pago subscription creation failed:', {
                    reference,
                    status: response.status,
                    code: payload.error,
                    message: payload.message,
                    causes
                });
                return res.status(502).json({
                    error: `O Mercado Pago não conseguiu iniciar a assinatura. Tente novamente. Referência: ${reference}.`
                });
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
                SET provider_status = $1, checkout_url = NULL, updated_at = NOW()
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
                    checkout_url = CASE WHEN $1 IN ('cancelled', 'canceled') THEN NULL ELSE checkout_url END,
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

    async function cancelOverdueSubscriptions() {
        const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
        if (!token) return;
        await ensureSchema();
        const overdue = await pool.query(`
            SELECT account_id, provider_subscription_id
            FROM saas_subscriptions
            WHERE provider_status = 'authorized'
              AND provider_subscription_id IS NOT NULL
              AND next_payment_at <= NOW()
        `);

        for (const subscription of overdue.rows) {
            try {
                const response = await fetch(
                    `${MERCADO_PAGO_API}/preapproval/${encodeURIComponent(subscription.provider_subscription_id)}`,
                    {
                        method: 'PUT',
                        headers: {
                            Authorization: `******`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ status: 'cancelled' })
                    }
                );
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    console.error('Overdue Mercado Pago subscription cancellation failed:', {
                        status: response.status,
                        message: payload.message || payload.error,
                        account_id: subscription.account_id
                    });
                    continue;
                }
                await pool.query(`
                    UPDATE saas_subscriptions
                    SET provider_status = $1, checkout_url = NULL, updated_at = NOW()
                    WHERE account_id = $2 AND next_payment_at <= NOW()
                `, [payload.status || 'cancelled', subscription.account_id]);
            } catch (error) {
                console.error('Overdue Mercado Pago subscription cancellation failed:', {
                    account_id: subscription.account_id,
                    error
                });
            }
        }
    }

    app.get('/admin.html', async (req, res) => {
        try {
            await ensureSchema();
            req.saasAccount = await getAccountForRequest(req);
            if (!req.saasAccount) return res.redirect('/entrar.html?tipo=dono&next=admin.html');

            const subscription = effectiveSubscription(req.saasAccount);
            if (!subscription.can_access || !req.saasAccount.space_id) return res.redirect('/assinatura.html');
            res.sendFile(path.join(frontendDirectory, 'admin.html'));
        } catch (error) {
            console.error('Owner dashboard access check failed:', error);
            res.status(503).send('Não foi possível validar o acesso. Tente novamente.');
        }
    });

    return {
        requireOwnedSpace,
        getCustomerForRequest,
        getPublicServicesForSpace: async (spaceId) => {
            await ensureSchema();
            return readServicesForSpace(spaceId);
        },
        getScheduleBlocksForSpace,
        cancelOverdueSubscriptions
    };
}

module.exports = {
    createSaasBilling,
    effectiveSubscription,
    getPlanConfig,
    hashPassword,
    isValidWebhookSignature,
    verifyPassword
};
