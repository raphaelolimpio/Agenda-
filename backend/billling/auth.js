const crypto = require('crypto');
const { effectiveSubscription } = require('./subscription-engine');

const SESSION_COOKIE = 'agenda_session';
const SESSION_DAYS = 30;

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

function clearSessionCookie(env = process.env) {
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
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

function createAuthService({ pool, ensureSchema, isTimeoutError }) {
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
                const timedOut = isTimeoutError(error);
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
                const timedOut = isTimeoutError(error);
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

    function registerAuthRoutes(app, { getPlanConfig }) {
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
                res.setHeader('Set-Cookie', clearSessionCookie(process.env));
                res.json({ message: 'Sessão encerrada.' });
            } catch (error) {
                console.error('SaaS logout failed:', error);
                res.status(500).json({ error: 'Não foi possível encerrar a sessão.' });
            }
        });
    }

    return {
        createPortalSession,
        createSession,
        getAccountForRequest,
        getCustomerForRequest,
        getPortalUser,
        registerAuthRoutes,
        requireAccount,
        requireOwnedSpace,
        requirePortalUser
    };
}

module.exports = {
    SESSION_COOKIE,
    SESSION_DAYS,
    createAuthService,
    hashPassword,
    isValidEmail,
    isValidOptionalImageUrl,
    normalizeWhatsAppPhone,
    parseCookies,
    sendWhatsAppTemplate,
    serializeSessionCookie,
    verifyPassword
};