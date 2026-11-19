const path = require('path');
const { createSchemaEnsure, ensureSaasSchema, isTimeoutError } = require('./billing/schema');
const {
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
} = require('./billing/auth');
const {
    MERCADO_PAGO_API,
    createSubscriptionService,
    effectiveSubscription,
    getPlanConfig,
    isValidCheckoutUrl,
    isValidWebhookSignature
} = require('./billing/subscription-engine');
const {
    createScheduleManagementService,
    scheduleBlockFromRow
} = require('./billing/schedule-management');
const {
    createSpaceCatalogService
} = require('./billing/space-catalog');

function createSaasBilling(app, pool, frontendDirectory) {
    const ensureSchema = createSchemaEnsure(pool);
    const authService = createAuthService({ pool, ensureSchema, isTimeoutError });
    const subscriptionService = createSubscriptionService({
        pool,
        ensureSchema,
        requireAccount: authService.requireAccount
    });
    const scheduleService = createScheduleManagementService({
        pool,
        ensureSchema,
        requireOwnedSpace: authService.requireOwnedSpace,
        requirePortalUser: authService.requirePortalUser
    });
    const catalogService = createSpaceCatalogService({
        pool,
        ensureSchema,
        isTimeoutError,
        requireAccount: authService.requireAccount,
        requireOwnedSpace: authService.requireOwnedSpace,
        requirePortalUser: authService.requirePortalUser
    });

    authService.registerAuthRoutes(app, { getPlanConfig });
    subscriptionService.registerSubscriptionRoutes(app);
    scheduleService.registerScheduleRoutes(app);
    catalogService.registerSpaceAndPortalRoutes(app);

    app.get('/admin.html', async (req, res) => {
        try {
            await ensureSchema();
            req.saasAccount = await authService.getAccountForRequest(req);
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
        requireOwnedSpace: authService.requireOwnedSpace,
        getCustomerForRequest: authService.getCustomerForRequest,
        getPublicServicesForSpace: catalogService.getPublicServicesForSpace,
        getPublicPaymentSettings: catalogService.getPublicPaymentSettings,
        getScheduleBlocksForSpace: scheduleService.getScheduleBlocksForSpace,
        cancelOverdueSubscriptions: subscriptionService.cancelOverdueSubscriptions
    };
}

module.exports = {
    MERCADO_PAGO_API,
    SESSION_COOKIE,
    SESSION_DAYS,
    createSaasBilling,
    effectiveSubscription,
    ensureSaasSchema,
    getPlanConfig,
    hashPassword,
    isValidCheckoutUrl,
    isValidWebhookSignature,
    parseCookies,
    scheduleBlockFromRow,
    sendWhatsAppTemplate,
    serializeSessionCookie,
    verifyPassword
};