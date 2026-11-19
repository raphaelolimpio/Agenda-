const crypto = require('crypto');

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

function createSubscriptionService({ pool, ensureSchema, requireAccount }) {
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
                            Authorization: `Bearer ${token}`,
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

    function registerSubscriptionRoutes(app) {
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
                        reason: `Vitrina+ - Plano mensal ${plan.monthlyPrice.toFixed(2)} BRL`,
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
    }

    return {
        cancelOverdueSubscriptions,
        registerSubscriptionRoutes
    };
}

module.exports = {
    MERCADO_PAGO_API,
    createSubscriptionService,
    effectiveSubscription,
    getPlanConfig,
    isValidCheckoutUrl,
    isValidWebhookSignature
};