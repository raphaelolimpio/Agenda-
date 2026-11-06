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

test('new SaaS registration creates and links a separate establishment', async () => {
    const routes = new Map();
    const app = {
        get(pathname, handler) {
            routes.set(`GET ${pathname}`, handler);
        },
        post(pathname, handler) {
            routes.set(`POST ${pathname}`, handler);
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
            senha: 'senha-segura-123',
            nome_loja: 'Studio Exemplo',
            segmento: 'salao'
        }
    }, response);

    const establishmentInsert = clientQueries.find(({ sql }) => sql.includes('INSERT INTO espacos'));
    const accountInsert = clientQueries.find(({ sql }) => sql.includes('INSERT INTO saas_accounts'));
    assert.ok(establishmentInsert);
    assert.ok(accountInsert);
    assert.equal(establishmentInsert.values[0], 'Studio Exemplo');
    assert.equal(accountInsert.values[1], 42);
    assert.equal(responseStatus, 201);
    assert.equal(responseBody.next, '/assinatura.html');
    assert.match(sessionCookie, /HttpOnly/);
    assert.ok(poolQueries.some(sql => sql.includes('INSERT INTO saas_sessions')));
    assert.equal(typeof billing.requireOwnedSpace, 'function');
});

test('vitrine writes are limited to the signed-in account establishment', async () => {
    const app = { get() {}, post() {} };
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
