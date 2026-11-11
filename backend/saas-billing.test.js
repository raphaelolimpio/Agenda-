const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
    effectiveSubscription,
    getPlanConfig,
    hashPassword,
    isValidWebhookSignature,
    createSaasBilling,
    verifyPassword
} = require('./saas-billing');
const { getDatabaseConfig } = require('./database-config');

test('database SSL defaults only relax certificate validation for the Railway proxy', () => {
    const railway = getDatabaseConfig(
        'postgresql://user:pass@shinkansen.proxy.rlwy.net:28306/railway?sslmode=require',
        { NODE_ENV: 'production' }
    );
    assert.deepEqual(railway.ssl, { rejectUnauthorized: false });
    assert.equal(new URL(railway.connectionString).searchParams.has('sslmode'), false);

    const localRailway = getDatabaseConfig(
        'postgresql://user:pass@shinkansen.proxy.rlwy.net:28306/railway?sslmode=require',
        { NODE_ENV: 'development' }
    );
    assert.deepEqual(localRailway.ssl, { rejectUnauthorized: false });

    const otherProvider = getDatabaseConfig(
        'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
        { NODE_ENV: 'production' }
    );
    assert.deepEqual(otherProvider.ssl, { rejectUnauthorized: true });

    const strictRailway = getDatabaseConfig(
        'postgresql://user:pass@shinkansen.proxy.rlwy.net:28306/railway',
        { NODE_ENV: 'production', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true' }
    );
    assert.deepEqual(strictRailway.ssl, { rejectUnauthorized: true });

    const trustedCa = getDatabaseConfig(
        'postgresql://user:pass@db.example.com:5432/app',
        { NODE_ENV: 'production', DATABASE_SSL_CA: 'test CA' }
    );
    assert.deepEqual(trustedCa.ssl, { rejectUnauthorized: true, ca: 'test CA' });
});

test('plan config defaults to R$ 50 and a seven-day trial', () => {
    assert.deepEqual(getPlanConfig({}), { monthlyPrice: 50, trialDays: 7 });
});

test('plan config rejects invalid values', () => {
    assert.throws(() => getPlanConfig({ SUBSCRIPTION_AMOUNT_BRL: '0' }));
    assert.throws(() => getPlanConfig({ TRIAL_DAYS: '1.5' }));
});

test('password hashes verify without storing the original password', () => {
    const password = 'correct-horse-battery';
    const hashedPassword = hashPassword(password);
    assert.notEqual(hashedPassword, password);
    assert.equal(verifyPassword(password, hashedPassword), true);
    assert.equal(verifyPassword('wrong-password', hashedPassword), false);
});

test('subscription access reflects provider authorization and trial expiry', () => {
    const active = effectiveSubscription({ provider_status: 'authorized' });
    assert.equal(active.status, 'active');
    assert.equal(active.can_access, true);

    const overdue = effectiveSubscription({
        provider_status: 'authorized',
        next_payment_at: new Date('2026-11-09T12:00:00.000Z')
    }, new Date('2026-11-10T12:00:00.000Z'));
    assert.equal(overdue.status, 'payment_overdue');
    assert.equal(overdue.can_access, false);

    const trial = effectiveSubscription({
        provider_status: 'pending',
        trial_ends_at: new Date(Date.now() + 60_000)
    });
    assert.equal(trial.status, 'trialing');
    assert.equal(trial.can_access, true);

    const expired = effectiveSubscription({
        provider_status: 'trialing',
        trial_ends_at: new Date(Date.now() - 60_000)
    });
    assert.equal(expired.status, 'expired');
    assert.equal(expired.can_access, false);
});

test('webhook signature verifies both second and millisecond timestamps', () => {
    const secret = 'test-webhook-secret';
    const dataId = '12345';
    const requestId = 'request-abc';

    for (const timestamp of [Math.floor(Date.now() / 1000), Date.now()]) {
        const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
        const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
        const headers = {
            'x-request-id': requestId,
            'x-signature': `ts=${timestamp},v1=${signature}`
        };
        assert.equal(isValidWebhookSignature(headers, dataId, secret), true);
        assert.equal(isValidWebhookSignature(headers, dataId, 'wrong-secret'), false);
    }
});

test('customer registration creates a hashed account and a persistent portal session', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const queries = [];
    const pool = {
        async query(sql, values = []) {
            queries.push({ sql, values });
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    let responseStatus = 200;
    let responseBody;
    let cookie;
    const response = {
        setHeader(name, value) { if (name === 'Set-Cookie') cookie = value; },
        status(status) { responseStatus = status; return this; },
        json(body) { responseBody = body; return this; }
    };

    await routes.get('POST /api/customer/register')({
        body: {
            nome: 'Cliente Exemplo',
            email: 'cliente@example.com',
            telefone: '+55 11 99999-9999',
            senha: 'senha-segura-123',
            remember: true
        }
    }, response);

    const accountInsert = queries.find(({ sql }) => sql.includes('INSERT INTO saas_customers'));
    const sessionInsert = queries.find(({ sql }) => sql.includes('INSERT INTO saas_portal_sessions'));
    assert.ok(accountInsert);
    assert.ok(sessionInsert);
    assert.notEqual(accountInsert.values[4], 'senha-segura-123');
    assert.equal(accountInsert.values[2], 'cliente@example.com');
    assert.equal(accountInsert.values[3], '5511999999999');
    assert.equal(sessionInsert.values[1], 'customer');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=/);
    assert.equal(responseStatus, 201);
    assert.equal(responseBody.next, '/cliente.html');
});

test('new SaaS registration creates, links, and confirms the account by WhatsApp', async (t) => {
    const originalFetch = global.fetch;
    const originalEnv = {
        WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION,
        WHATSAPP_TEMPLATE_ACCOUNT_CREATED: process.env.WHATSAPP_TEMPLATE_ACCOUNT_CREATED
    };
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-whatsapp-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    process.env.WHATSAPP_API_VERSION = 'v99.0';
    process.env.WHATSAPP_TEMPLATE_ACCOUNT_CREATED = 'agenda_conta_criada';
    let whatsappPayload;
    global.fetch = async (url, options) => {
        assert.equal(url, 'https://graph.facebook.com/v99.0/123456789/messages');
        whatsappPayload = JSON.parse(options.body);
        return { ok: true, status: 200 };
    };
    t.after(() => {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const routes = new Map();
    const app = {
        get(pathname, handler) {
            routes.set(`GET ${pathname}`, handler);
        },
        post(pathname, handler) {
            routes.set(`POST ${pathname}`, handler);
        },
        patch(pathname, handler) {
            routes.set(`PATCH ${pathname}`, handler);
        },
        delete(pathname, handler) {
            routes.set(`DELETE ${pathname}`, handler);
        }
    };
    const poolQueries = [];
    const clientQueries = [];
    const pool = {
        async query(sql) {
            poolQueries.push(sql);
            return { rows: [] };
        },
        async connect() {
            return {
                async query(sql, values = []) {
                    clientQueries.push({ sql, values });
                    if (sql.includes('INSERT INTO espacos')) return { rows: [{ id: 42 }] };
                    return { rows: [] };
                },
                release() {}
            };
        }
    };
    const billing = createSaasBilling(app, pool, 'frontend');
    let responseStatus;
    let responseBody;
    let sessionCookie;
    const response = {
        setHeader(name, value) {
            if (name === 'Set-Cookie') sessionCookie = value;
        },
        status(status) {
            responseStatus = status;
            return this;
        },
        json(body) {
            responseBody = body;
            return this;
        }
    };

    const register = routes.get('POST /api/saas/register');
    assert.ok(register);
    await register({
        body: {
            nome: 'Pessoa Exemplo',
            email: 'pessoa@example.com',
            telefone_whatsapp: '+55 (11) 99999-9999',
            consentimento_whatsapp: true,
            senha: 'senha-segura-123',
            nome_loja: 'Studio Exemplo',
            segmento: 'salao'
        }
    }, response);

    const establishmentInsert = clientQueries.find(({ sql }) => sql.includes('INSERT INTO espacos'));
    const accountInsert = clientQueries.find(({ sql }) => sql.includes('INSERT INTO saas_accounts'));
    const subscriptionInsert = clientQueries.find(({ sql }) => sql.includes('INSERT INTO saas_subscriptions'));
    assert.ok(establishmentInsert);
    assert.ok(accountInsert);
    assert.ok(subscriptionInsert);
    assert.equal(clientQueries.filter(({ sql }) => sql.includes('INSERT INTO saas_subscriptions')).length, 1);
    assert.ok(clientQueries.indexOf(establishmentInsert) < clientQueries.indexOf(accountInsert));
    assert.ok(clientQueries.indexOf(accountInsert) < clientQueries.indexOf(subscriptionInsert));
    assert.equal(establishmentInsert.values[0], 'Studio Exemplo');
    assert.equal(accountInsert.values[1], 42);
    assert.equal(accountInsert.values[4], '5511999999999');
    assert.equal(subscriptionInsert.values[0], accountInsert.values[0]);
    assert.equal(responseStatus, 201);
    assert.equal(responseBody.next, '/admin.html');
    assert.equal(responseBody.whatsapp_notification, 'sent');
    assert.equal(whatsappPayload.to, '5511999999999');
    assert.equal(whatsappPayload.template.name, 'agenda_conta_criada');
    assert.equal(whatsappPayload.template.components[0].parameters[0].text, 'Pessoa Exemplo');
    assert.match(sessionCookie, /HttpOnly/);
    assert.ok(poolQueries.some(sql => sql.includes('INSERT INTO saas_sessions')));
    assert.equal(typeof billing.requireOwnedSpace, 'function');
});

test('login sends active and trial accounts to the dashboard and expired accounts to billing', async () => {
    const storedPassword = hashPassword('senha-segura-123');
    const cases = [
        {
            name: 'active subscription',
            account: {
                id: 'active-account',
                password_hash: storedPassword,
                space_id: 42,
                provider_status: 'authorized',
                amount_brl: '50.00',
                trial_days: 7,
                trial_ends_at: null
            },
            next: '/admin.html'
        },
        {
            name: 'active trial',
            account: {
                id: 'trial-account',
                password_hash: storedPassword,
                space_id: 42,
                provider_status: 'trialing',
                amount_brl: '50.00',
                trial_days: 7,
                trial_ends_at: new Date(Date.now() + 60_000)
            },
            next: '/admin.html'
        },
        {
            name: 'expired trial',
            account: {
                id: 'expired-account',
                password_hash: storedPassword,
                space_id: 42,
                provider_status: 'trialing',
                amount_brl: '50.00',
                trial_days: 7,
                trial_ends_at: new Date(Date.now() - 60_000)
            },
            next: '/assinatura.html'
        }
    ];

    for (const testCase of cases) {
        const routes = new Map();
        const app = {
            get(pathname, handler) {
                routes.set(`GET ${pathname}`, handler);
            },
            post(pathname, handler) {
                routes.set(`POST ${pathname}`, handler);
            },
            patch(pathname, handler) {
                routes.set(`PATCH ${pathname}`, handler);
            },
            delete(pathname, handler) {
                routes.set(`DELETE ${pathname}`, handler);
            }
        };
        const pool = {
            async query(sql) {
                if (sql.includes('FROM saas_accounts a')) return { rows: [testCase.account] };
                return { rows: [] };
            }
        };
        createSaasBilling(app, pool, 'frontend');
        const response = {
            statusCode: 200,
            status(status) {
                this.statusCode = status;
                return this;
            },
            setHeader() {},
            json(body) {
                this.body = body;
                return this;
            }
        };

        await routes.get('POST /api/saas/login')({
            body: { email: 'pessoa@example.com', senha: 'senha-segura-123' }
        }, response);
        assert.equal(response.statusCode, 200, testCase.name);
        assert.equal(response.body.next, testCase.next, testCase.name);
    }
});

test('password reset sends an unguessable hashed token to the registered WhatsApp and invalidates sessions', async () => {
    const originalFetch = global.fetch;
    const originalEnv = {
        WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION,
        WHATSAPP_TEMPLATE_PASSWORD_RESET: process.env.WHATSAPP_TEMPLATE_PASSWORD_RESET,
        APP_BASE_URL: process.env.APP_BASE_URL,
        NODE_ENV: process.env.NODE_ENV
    };
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-whatsapp-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    process.env.WHATSAPP_API_VERSION = 'v99.0';
    process.env.WHATSAPP_TEMPLATE_PASSWORD_RESET = 'agenda_recuperar_senha';
    process.env.APP_BASE_URL = 'https://agenda.example.com';
    process.env.NODE_ENV = 'production';

    const routes = new Map();
    const app = {
        get(pathname, handler) {
            routes.set(`GET ${pathname}`, handler);
        },
        post(pathname, handler) {
            routes.set(`POST ${pathname}`, handler);
        },
        patch(pathname, handler) {
            routes.set(`PATCH ${pathname}`, handler);
        },
        delete(pathname, handler) {
            routes.set(`DELETE ${pathname}`, handler);
        }
    };
    const accountId = 'account-id';
    const poolQueries = [];
    const clientQueries = [];
    let resetTokenUsed = false;
    const pool = {
        async query(sql, values = []) {
            poolQueries.push({ sql, values });
            if (sql.includes('SELECT id, full_name, whatsapp_phone FROM saas_accounts')) {
                return values[0] === 'pessoa@example.com'
                    ? { rows: [{
                        id: accountId,
                        full_name: 'Pessoa Exemplo',
                        whatsapp_phone: '5511999999999'
                    }] }
                    : { rows: [] };
            }
            if (sql.includes('SELECT EXISTS')) return { rows: [{ requested_recently: false }] };
            return { rows: [] };
        },
        async connect() {
            return {
                async query(sql, values = []) {
                    clientQueries.push({ sql, values });
                    if (sql.includes('SELECT account_id')) {
                        return resetTokenUsed ? { rows: [] } : { rows: [{ account_id: accountId }] };
                    }
                    if (sql.includes('UPDATE saas_password_resets')) resetTokenUsed = true;
                    return { rows: [] };
                },
                release() {}
            };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    let whatsappPayload;
    global.fetch = async (url, options) => {
        assert.equal(url, 'https://graph.facebook.com/v99.0/123456789/messages');
        assert.equal(options.headers.Authorization, 'Bearer test-whatsapp-token');
        whatsappPayload = JSON.parse(options.body);
        return { ok: true, status: 200 };
    };

    const makeResponse = () => ({
        statusCode: 200,
        status(status) {
            this.statusCode = status;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    });

    try {
        const requestReset = routes.get('POST /api/saas/request-password-reset');
        const knownEmailResponse = makeResponse();
        await requestReset({ body: { email: 'Pessoa@example.com' } }, knownEmailResponse);
        const unknownEmailResponse = makeResponse();
        await requestReset({ body: { email: 'desconhecido@example.com' } }, unknownEmailResponse);

        assert.equal(knownEmailResponse.statusCode, 200);
        assert.deepEqual(knownEmailResponse.body, unknownEmailResponse.body);
        assert.equal(whatsappPayload.to, '5511999999999');
        assert.equal(whatsappPayload.template.name, 'agenda_recuperar_senha');
        const resetLink = whatsappPayload.template.components[0].parameters[1].text;
        const resetToken = new URL(resetLink).hash.slice(1).match(/token=([a-f\d]{64})/i)[1];
        assert.equal(resetToken.length, 64);
        const insertedReset = poolQueries.find(({ sql }) => sql.includes('INSERT INTO saas_password_resets'));
        const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        assert.equal(insertedReset.values[0], resetTokenHash);
        assert.notEqual(insertedReset.values[0], resetToken);

        const resetResponse = makeResponse();
        await routes.get('POST /api/saas/reset-password')({
            body: { token: resetToken, senha: 'nova-senha-segura-123' }
        }, resetResponse);
        const passwordUpdate = clientQueries.find(({ sql }) => sql.includes('UPDATE saas_accounts'));
        assert.equal(resetResponse.statusCode, 200);
        assert.equal(verifyPassword('nova-senha-segura-123', passwordUpdate.values[0]), true);
        assert.ok(clientQueries.some(({ sql, values }) => sql.includes('UPDATE saas_password_resets') && values[0] === resetTokenHash));
        assert.ok(clientQueries.some(({ sql, values }) => sql.includes('DELETE FROM saas_sessions') && values[0] === accountId));
        assert.ok(clientQueries.some(({ sql }) => sql === 'COMMIT'));

        const reusedTokenResponse = makeResponse();
        await routes.get('POST /api/saas/reset-password')({
            body: { token: resetToken, senha: 'outra-senha-segura-123' }
        }, reusedTokenResponse);
        assert.equal(reusedTokenResponse.statusCode, 400);
    } finally {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('administrative password reset links require a secret and contain only an expiring token', async () => {
    const originalEnv = {
        PASSWORD_RESET_ADMIN_KEY: process.env.PASSWORD_RESET_ADMIN_KEY,
        APP_BASE_URL: process.env.APP_BASE_URL,
        NODE_ENV: process.env.NODE_ENV
    };
    const adminKey = 'test-password-reset-admin-key-32-chars';
    process.env.PASSWORD_RESET_ADMIN_KEY = adminKey;
    process.env.APP_BASE_URL = 'https://agenda.example.com';
    process.env.NODE_ENV = 'production';

    const routes = new Map();
    const app = {
        get(pathname, handler) {
            routes.set(`GET ${pathname}`, handler);
        },
        post(pathname, handler) {
            routes.set(`POST ${pathname}`, handler);
        },
        patch(pathname, handler) {
            routes.set(`PATCH ${pathname}`, handler);
        },
        delete(pathname, handler) {
            routes.set(`DELETE ${pathname}`, handler);
        }
    };
    const accountId = 'account-id';
    const poolQueries = [];
    const pool = {
        async query(sql, values = []) {
            poolQueries.push({ sql, values });
            if (sql.includes('SELECT id FROM saas_accounts')) {
                return values[0] === 'pessoa@example.com' ? { rows: [{ id: accountId }] } : { rows: [] };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const makeResponse = () => ({
        statusCode: 200,
        status(status) {
            this.statusCode = status;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    });

    try {
        const generateLink = routes.get('POST /api/saas/admin/password-reset-link');
        const unauthorizedResponse = makeResponse();
        await generateLink({ headers: {}, body: { email: 'pessoa@example.com' } }, unauthorizedResponse);
        assert.equal(unauthorizedResponse.statusCode, 401);

        const response = makeResponse();
        await generateLink({
            headers: { 'x-password-reset-admin-key': adminKey },
            body: { email: 'Pessoa@example.com' }
        }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.expires_in_minutes, 30);
        const token = new URL(response.body.reset_url).hash.slice(1).match(/token=([a-f\d]{64})/i)[1];
        const insertedReset = poolQueries.find(({ sql }) => sql.includes('INSERT INTO saas_password_resets'));
        assert.equal(insertedReset.values[0], crypto.createHash('sha256').update(token).digest('hex'));
        assert.equal(insertedReset.values[1], accountId);
        assert.ok(poolQueries.some(({ sql, values }) => sql.includes('UPDATE saas_password_resets') && values[0] === accountId));

        const unknownAccountResponse = makeResponse();
        await generateLink({
            headers: { 'x-password-reset-admin-key': adminKey },
            body: { email: 'desconhecido@example.com' }
        }, unknownAccountResponse);
        assert.equal(unknownAccountResponse.statusCode, 404);
    } finally {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('vitrine writes are limited to the signed-in account establishment', async () => {
    const app = { get() {}, post() {}, patch() {}, delete() {} };
    const account = {
        id: 'account-id',
        space_id: 42,
        provider_status: 'authorized',
        amount_brl: '50.00',
        trial_days: 7,
        trial_ends_at: null,
        next_payment_at: null,
        checkout_url: null
    };
    const pool = {
        async query(sql) {
            if (sql.includes('SELECT a.id, a.space_id')) return { rows: [account] };
            return { rows: [] };
        }
    };
    const billing = createSaasBilling(app, pool, 'frontend');
    const middleware = billing.requireOwnedSpace((req, res) => {
        res.authorized = true;
    });
    const request = {
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` },
        params: { id: '42' }
    };
    const allowedResponse = { status() { return this; }, json() { return this; } };
    await middleware(request, allowedResponse);
    assert.equal(allowedResponse.authorized, true);

    const deniedResponse = {
        statusCode: null,
        status(status) {
            this.statusCode = status;
            return this;
        },
        json() {
            return this;
        }
    };
    await middleware({ ...request, params: { id: '43' } }, deniedResponse);
    assert.equal(deniedResponse.statusCode, 403);
});

test('owner authorization returns a retryable response when database queries time out', async () => {
    const app = { get() {}, post() {}, patch() {}, delete() {} };
    const pool = {
        async query() {
            const error = new Error('statement timeout');
            error.code = '57014';
            throw error;
        }
    };
    const billing = createSaasBilling(app, pool, 'frontend');
    const middleware = billing.requireOwnedSpace(() => {});
    const response = {
        statusCode: null,
        payload: null,
        status(status) {
            this.statusCode = status;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };

    await middleware({ headers: { cookie: `agenda_session=${'a'.repeat(64)}` }, params: { id: '42' } }, response);

    assert.equal(response.statusCode, 503);
    assert.match(response.payload.error, /banco de dados demorou/);
});
