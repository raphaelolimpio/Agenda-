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
const { isAllowedOrigin } = require('./origin-policy');
const { getUtcWeekday } = require('./date-utils');
const {
    appointmentBlocksProfessional,
    appointmentOverlaps,
    isBlockedPeriod,
    isValidScheduleBlock
} = require('./schedule-utils');

test('calendar dates use the same weekday regardless of server timezone', () => {
    assert.equal(getUtcWeekday('2026-11-19'), 4);
    assert.equal(getUtcWeekday('2026-11-22'), 0);
    assert.equal(getUtcWeekday('2026-02-29'), null);
    assert.equal(getUtcWeekday('2026-11-19T00:00:00Z'), null);
});

test('schedule blocks apply by date, recurring weekday, and across midnight', () => {
    const blocks = [
        {
            tipoAlvo: 'dia',
            tipoRecorrencia: 'especifico',
            valor: '2026-11-19'
        },
        {
            tipoAlvo: 'horario',
            tipoRecorrencia: 'semana_recorrente',
            valor: '4',
            horaInicio: '22:00',
            horaFim: '02:00'
        }
    ];

    assert.equal(isBlockedPeriod(blocks, '2026-11-19', 9 * 60, 10 * 60), true);
    assert.equal(isBlockedPeriod(blocks, '2026-11-26', 23 * 60, 23 * 60 + 30), true);
    assert.equal(isBlockedPeriod(blocks, '2026-11-27', 60, 90), true);
    assert.equal(isBlockedPeriod(blocks, '2026-11-27', 9 * 60, 10 * 60), false);
});

test('schedule block validation rejects malformed dates and time ranges', () => {
    assert.equal(isValidScheduleBlock({
        tipoAlvo: 'dia',
        tipoRecorrencia: 'especifico',
        valor: '2026-02-29',
        motivo: 'Folga'
    }), false);
    assert.equal(isValidScheduleBlock({
        tipoAlvo: 'horario',
        tipoRecorrencia: 'diario_recorrente',
        valor: 'todos_os_dias',
        horaInicio: '09:00',
        horaFim: '09:00',
        motivo: 'Almoço'
    }), false);
});

test('employee appointments block overlapping times at every linked store only for that employee', () => {
    const employee = { type: 'employee', id: 'employee-a' };
    const otherEmployee = { type: 'employee', id: 'employee-b' };
    const crossStoreAppointment = {
        space_id: 43,
        local_date: '2026-11-19',
        end_date: '2026-11-19',
        start_time: '10:00',
        end_time: '11:00',
        saas_professional_type: 'employee',
        saas_professional_id: 'EMPLOYEE-A'
    };

    assert.equal(appointmentBlocksProfessional(crossStoreAppointment, employee, 42), true);
    assert.equal(appointmentOverlaps('2026-11-19', 10 * 60 + 30, 11 * 60 + 30, crossStoreAppointment), true);
    assert.equal(appointmentBlocksProfessional(crossStoreAppointment, otherEmployee, 42), false);
    assert.equal(appointmentOverlaps('2026-11-19', 11 * 60, 12 * 60, crossStoreAppointment), false);
});

test('origin policy allows only the configured site and this project Vercel deployments', () => {
    const configured = new Set(['https://agenda.example.com']);
    assert.equal(isAllowedOrigin(undefined, configured), true);
    assert.equal(isAllowedOrigin('https://agenda.example.com', configured), true);
    assert.equal(isAllowedOrigin('https://agenda-frontend-phi.vercel.app', configured), true);
    assert.equal(isAllowedOrigin(
        'https://agenda-frontend-7f8puxf94-raphaelolimpios-projects.vercel.app',
        configured
    ), true);
    assert.equal(isAllowedOrigin(
        'https://other-project-123-raphaelolimpios-projects.vercel.app',
        configured
    ), false);
    assert.equal(isAllowedOrigin(
        'https://agenda-frontend-123-other-user.vercel.app',
        configured
    ), false);
    assert.equal(isAllowedOrigin(
        'http://agenda-frontend-123-raphaelolimpios-projects.vercel.app',
        configured
    ), false);
});

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

test('customer and employee profiles validate and persist optional photo URLs', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const pool = {
        async query(sql, values = []) {
            if (sql.includes('SELECT user_id')) {
                return { rows: [{ user_id: `${values[1]}-id` }] };
            }
            if (sql.includes('UPDATE saas_customers')) {
                return {
                    rows: [{
                        id: values[5],
                        full_name: values[0],
                        email: values[1],
                        phone: values[2],
                        photo_url: values[4]
                    }]
                };
            }
            if (sql.includes('UPDATE saas_employees')) {
                return {
                    rows: [{
                        id: values[1],
                        full_name: 'Profissional',
                        email: 'profissional@example.com',
                        photo_url: values[0] || null
                    }]
                };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = () => ({
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.payload = body;
            return this;
        }
    });
    const cookie = `agenda_session=${'a'.repeat(64)}`;
    const customerResponse = response();
    await routes.get('PATCH /api/customer/profile')({
        headers: { cookie },
        body: {
            nome: 'Cliente Exemplo',
            email: 'cliente@example.com',
            telefone: '+5511999999999',
            photo_url: 'https://images.example.com/cliente.jpg'
        }
    }, customerResponse);
    assert.equal(customerResponse.statusCode, 200);
    assert.equal(customerResponse.payload.customer.photo_url, 'https://images.example.com/cliente.jpg');

    const invalidPhotoResponse = response();
    await routes.get('PATCH /api/employee/profile')({
        headers: { cookie },
        body: { photo_url: 'javascript:alert(1)' }
    }, invalidPhotoResponse);
    assert.equal(invalidPhotoResponse.statusCode, 400);

    const employeeResponse = response();
    await routes.get('PATCH /api/employee/profile')({
        headers: { cookie },
        body: { photo_url: 'https://images.example.com/profissional.jpg' }
    }, employeeResponse);
    assert.equal(employeeResponse.statusCode, 200);
    assert.equal(employeeResponse.payload.employee.photo_url, 'https://images.example.com/profissional.jpg');
});

test('employee registration does not require or process a company code', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const clientQueries = [];
    const client = {
        async query(sql) {
            clientQueries.push(sql);
            return { rows: [] };
        },
        release() {}
    };
    const pool = {
        async query() { return { rows: [] }; },
        async connect() { return client; }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader() {},
        json(body) { this.body = body; return this; }
    };

    await routes.get('POST /api/employee/register')({
        body: {
            nome: 'Profissional Exemplo',
            email: 'profissional@example.com',
            senha: 'senha-segura-123',
            codigo_empresa: 'invalid-code'
        }
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.next, '/colaborador.html?aba=perfil&vincular=1');
    assert.ok(clientQueries.includes('COMMIT'));
    assert.equal(clientQueries.some((sql) => sql.includes('saas_employee_spaces')), false);
});

test('owner can persist a commission percentage only for a linked employee', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
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
    const employeeId = '123e4567-e89b-12d3-a456-426614174000';
    const pool = {
        async query(sql, values = []) {
            if (sql.includes('FROM saas_sessions session')) return { rows: [account] };
            if (sql.includes('UPDATE saas_employee_spaces')) {
                assert.deepEqual(values, [35.5, employeeId, 42]);
                return {
                    rows: [{ employee_id: employeeId, space_id: 42, company_percentage: '35.50' }]
                };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    const handler = routes.get('PATCH /api/saas/employees/:employeeId/commission');

    await handler({
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` },
        params: { employeeId },
        body: { company_percentage: 101 }
    }, response);
    assert.equal(response.statusCode, 400);

    response.statusCode = 200;
    await handler({
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` },
        params: { employeeId },
        body: { company_percentage: 35.5 }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.commission.company_percentage, '35.50');
});

test('public service catalog includes professionals linked by the owner', async () => {
    const app = {
        get() {},
        post() {},
        patch() {},
        delete() {}
    };
    const employeeId = 'c0c3f5b5-1cef-44df-a3d5-f953f59986b9';
    const pool = {
        async query(sql) {
            if (sql.includes('FROM servicos')) {
                return {
                    rows: [{ id: 17, nome: 'Aula de Kart', categoria: 'Esporte', duracao_minutos: 60, preco: '200.00' }]
                };
            }
            if (sql.includes('FROM saas_service_professionals')) {
                return {
                    rows: [{
                        service_id: '17',
                        professional_id: employeeId,
                        professional_type: 'employee',
                        professional_name: 'Rapha'
                    }]
                };
            }
            return { rows: [] };
        }
    };
    const billing = createSaasBilling(app, pool, 'frontend');
    const services = await billing.getPublicServicesForSpace(5);

    assert.deepEqual(services[0].profissionais, [{
        id: employeeId,
        type: 'employee',
        nome: 'Rapha'
    }]);
});

test('owner service creation persists catalog data and selected professionals', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const accountId = '123e4567-e89b-12d3-a456-426614174000';
    const employeeId = '223e4567-e89b-12d3-a456-426614174000';
    const serviceId = 12;
    const account = {
        id: accountId,
        space_id: 42,
        provider_status: 'authorized',
        amount_brl: '50.00',
        trial_days: 7,
        trial_ends_at: null,
        next_payment_at: null,
        checkout_url: null
    };
    const clientQueries = [];
    const client = {
        async query(sql, values = []) {
            clientQueries.push({ sql, values });
            if (sql.includes('INSERT INTO servicos')) return { rows: [{ id: serviceId }] };
            if (sql.includes('FROM saas_employee_spaces')) return { rows: [{ id: employeeId }] };
            if (sql.includes('FROM saas_accounts')) return { rows: [{ id: accountId }] };
            return { rows: [] };
        },
        release() {}
    };
    const pool = {
        async query(sql) {
            if (sql.includes('FROM saas_sessions session')) return { rows: [account] };
            return { rows: [] };
        },
        async connect() { return client; }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('POST /api/saas/spaces/:id/services')({
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` },
        params: { id: '42' },
        body: {
            nome: 'Aula de Pilates',
            categoria: 'Saúde',
            duracao_minutos: 60,
            preco: 200,
            profissionais: [accountId, employeeId]
        }
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.id, serviceId);
    assert.ok(clientQueries.some(({ sql, values }) =>
        sql.includes('INSERT INTO servicos')
        && values[1] === 'Aula de Pilates'
        && values[3] === 60
        && values[4] === 200
    ));
    assert.ok(clientQueries.some(({ sql, values }) =>
        sql.includes('saas_service_professionals')
        && values[2] === 'owner'
        && values[3] === accountId
    ));
    assert.ok(clientQueries.some(({ sql, values }) =>
        sql.includes('saas_service_professionals')
        && values[2] === 'employee'
        && values[3] === employeeId
    ));
    assert.ok(clientQueries.some(({ sql }) => sql === 'COMMIT'));
});

test('employee profile includes linked stores even without a subscription row', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const pool = {
        async query(sql) {
            if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'employee-id' }] };
            if (sql.includes('FROM saas_employees')) {
                return { rows: [{ id: 'employee-id', full_name: 'Profissional', email: 'profissional@example.com' }] };
            }
            if (sql.includes('FROM saas_employee_spaces')) {
                assert.match(sql, /LEFT JOIN saas_subscriptions/);
                return {
                    rows: [{
                        space_id: 42,
                        store_name: 'Loja Exemplo',
                        company_percentage: '25.00',
                        provider_status: null,
                        trial_ends_at: null,
                        next_payment_at: null
                    }]
                };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('GET /api/employee/me')({
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.spaces[0].store_name, 'Loja Exemplo');
    assert.equal(response.body.spaces[0].company_percentage, 25);
    assert.equal(response.body.spaces[0].can_access, false);
});

test('employee schedule combines linked-store appointments with store and personal blocks', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const pool = {
        async query(sql) {
            if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'employee-id' }] };
            if (sql.includes('FROM saas_employee_spaces')) {
                return { rows: [{ space_id: 42, store_name: 'Loja A' }, { space_id: 43, store_name: 'Loja B' }] };
            }
            if (sql.includes('FROM saas_schedule_blocks b')) {
                return {
                    rows: [
                        {
                            id: 'block-store',
                            owner_space_id: 42,
                            employee_id: null,
                            tipo_alvo: 'dia',
                            tipo_recorrencia: 'especifico',
                            valor: '2026-11-19',
                            motivo: 'Fechado',
                            store_name: 'Loja A'
                        },
                        {
                            id: 'block-employee',
                            owner_space_id: null,
                            employee_id: 'employee-id',
                            tipo_alvo: 'dia',
                            tipo_recorrencia: 'semana_recorrente',
                            valor: '1',
                            motivo: 'Folga'
                        }
                    ]
                };
            }
            if (sql.includes('FROM agendamentos a')) {
                return {
                    rows: [
                        {
                            id: 1, space_id: 42, store_name: 'Loja A', local_date: '2026-11-19',
                            local_time: '10:00', cliente_nome: 'Cliente A', cliente_telefone: '111',
                            status: 'confirmado', service_name: 'Corte', service_price: '40.00'
                        },
                        {
                            id: 2, space_id: 43, store_name: 'Loja B', local_date: '2026-11-19',
                            local_time: '11:00', cliente_nome: 'Cliente B', cliente_telefone: '222',
                            status: 'pago', service_name: 'Barba', service_price: '25.00'
                        }
                    ]
                };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('GET /api/employee/schedule')({
        headers: { cookie: `agenda_session=${'b'.repeat(64)}` },
        query: {}
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.appointments.map((appointment) => appointment.space_id), [42, 43]);
    assert.deepEqual(response.body.blocks.map((block) => block.scope), ['store', 'employee']);
});

test('employee schedule blocks are saved as personal cross-store blocks', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    let insertValues;
    const pool = {
        async query(sql, values = []) {
            if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'employee-id' }] };
            if (sql.includes('INSERT INTO saas_schedule_blocks')) insertValues = values;
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('POST /api/employee/schedule/blocks')({
        headers: { cookie: `agenda_session=${'c'.repeat(64)}` },
        body: {
            tipoAlvo: 'dia',
            tipoRecorrencia: 'especifico',
            valor: '2026-11-19',
            motivo: 'Consulta'
        }
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.block.scope, 'employee');
    assert.equal(insertValues[1], null);
    assert.equal(insertValues[2], 'employee-id');
});

test('owner appointment schedule returns dates, prices, payment method and customer details', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const appointmentQuery = [];
    const pool = {
        async query(sql, values = []) {
            if (sql.includes('FROM saas_sessions session')) {
                return {
                    rows: [{
                        id: 'owner-id',
                        space_id: 42,
                        full_name: 'Dono',
                        provider_status: 'authorized',
                        next_payment_at: '2027-01-01T00:00:00Z'
                    }]
                };
            }
            if (sql.includes('FROM agendamentos a')) {
                appointmentQuery.push({ sql, values });
                return {
                    rows: [{
                        id: 12,
                        servico_id: 3,
                        saas_professional_id: 'employee-id',
                        saas_professional_type: 'employee',
                        data: '2026-11-13',
                        hora: '08:00',
                        cliente_nome: 'Cliente',
                        cliente_telefone: '5511999999999',
                        status: 'confirmado',
                        forma_pagamento: 'pix',
                        servico_nome: 'Aula',
                        valor: '200.00',
                        profissional_nome: 'Profissional'
                    }]
                };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('GET /api/saas/spaces/:id/appointments')({
        headers: { cookie: `agenda_session=${'d'.repeat(64)}` },
        params: { id: '42' },
        query: { from: '2026-11-08', to: '2026-11-15' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.appointments[0].valor, 200);
    assert.equal(response.body.appointments[0].status, 'agendado');
    assert.equal(response.body.appointments[0].forma_pagamento, 'pix');
    assert.deepEqual(appointmentQuery[0].values, ['42', '2026-11-08', '2026-11-15']);
});

test('owner can save PIX key for public booking instructions', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    let updateValues;
    const pool = {
        async query(sql, values = []) {
            if (sql.includes('FROM saas_sessions session')) {
                return { rows: [{ id: 'owner-id', space_id: 42, provider_status: 'authorized' }] };
            }
            if (sql.includes('UPDATE saas_accounts') && sql.includes('pix_key')) {
                updateValues = values;
                return { rows: [{ pix_key: 'pix@loja.com.br' }] };
            }
            if (sql.includes('SELECT pix_key FROM saas_accounts WHERE space_id')) {
                return { rows: [{ pix_key: 'pix@loja.com.br' }] };
            }
            return { rows: [] };
        }
    };
    const billing = createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('PATCH /api/saas/payment-settings')({
        headers: { cookie: `agenda_session=${'e'.repeat(64)}` },
        body: { pix_key: ' pix@loja.com.br ' }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.pix_key, 'pix@loja.com.br');
    assert.deepEqual(updateValues, ['pix@loja.com.br', 'owner-id']);
    assert.deepEqual(await billing.getPublicPaymentSettings(42), { pix_key: 'pix@loja.com.br' });
});

test('customer profile data endpoint returns all customer portal sections', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
        patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
        delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); }
    };
    const queries = [];
    const pool = {
        async query(sql) {
            queries.push(sql);
            if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'customer-id' }] };
            if (sql.includes('FROM saas_customers')) {
                return { rows: [{ id: 'customer-id', full_name: 'Cliente', email: 'cliente@example.com', phone: '5511999999999' }] };
            }
            return { rows: [] };
        }
    };
    createSaasBilling(app, pool, 'frontend');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    await routes.get('GET /api/customer/me')({
        headers: { cookie: `agenda_session=${'a'.repeat(64)}` }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.customer.id, 'customer-id');
    assert.deepEqual(response.body.favorites, []);
    assert.deepEqual(response.body.recent_visits, []);
    assert.deepEqual(response.body.upcoming, []);
    assert.deepEqual(response.body.history, []);
    assert.ok(queries.some((sql) => sql.includes('a.saas_cliente_id = $1')));
});
