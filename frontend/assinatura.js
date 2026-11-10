const statusNames = {
    active: 'Plano mensal',
    trialing: 'Em período de teste',
    not_started: 'Não iniciada',
    payment_pending: 'Aguardando pagamento',
    payment_failed: 'Pagamento recusado',
    payment_overdue: 'Pagamento vencido — acesso suspenso',
    cancelled: 'Cancelada',
    paused: 'Pausada',
    expired: 'Período encerrado'
};

const formatDate = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(date);
};

function showBillingMessage(message, isError = false) {
    const element = document.getElementById('billingMessage');
    element.textContent = message;
    element.dataset.state = isError ? 'error' : '';
}

async function loadSubscription() {
    const [data, plan] = await Promise.all([
        AppApi.request('/api/saas/me'),
        AppApi.request('/api/saas/plan')
    ]);
    const { account, subscription } = data;
    const formattedPrice = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: plan.currency
    }).format(Number(plan.amount));

    document.getElementById('planPrice').textContent = formattedPrice;
    document.getElementById('planTrial').textContent = plan.trial_days
        ? `${plan.trial_days} dias grátis para novos cadastros.`
        : 'Cobrança iniciada após confirmar o pagamento.';
    document.getElementById('accountStore').textContent = account.store_name;
    document.getElementById('accountOwner').textContent = `${account.full_name} · ${account.email}`;
    document.getElementById('subscriptionStatus').textContent = statusNames[subscription.status] || 'Status atualizado';
    document.getElementById('trialEnd').textContent = formatDate(subscription.trial_ends_at);
    document.getElementById('nextPayment').textContent = formatDate(subscription.next_payment_at);

    const dashboardLink = document.getElementById('dashboardLink');
    dashboardLink.hidden = !subscription.can_access;
    document.getElementById('headerDashboardLink').hidden = !subscription.can_access;
    document.getElementById('subscriptionMenuPlan').hidden = subscription.status === 'active';

    const checkoutButton = document.getElementById('checkoutButton');
    checkoutButton.disabled = false;
    if (subscription.status === 'active') {
        checkoutButton.textContent = 'Plano mensal ativo';
        checkoutButton.disabled = true;
    } else if (subscription.status === 'payment_overdue') {
        checkoutButton.textContent = 'Regularizar pagamento';
    } else {
        checkoutButton.textContent = subscription.checkout_url
            ? 'Continuar no Mercado Pago'
            : 'Configurar pagamento';
    }

    const cancelButton = document.getElementById('cancelButton');
    cancelButton.hidden = !subscription.can_cancel;
}

document.getElementById('checkoutButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    showBillingMessage('Conectando ao Mercado Pago...');
    try {
        const result = await AppApi.request('/api/saas/checkout', { method: 'POST' });
        window.location.assign(result.checkout_url);
    } catch (error) {
        showBillingMessage(error.message, true);
        button.disabled = false;
    }
});

document.getElementById('cancelButton').addEventListener('click', async (event) => {
    if (!window.confirm('Deseja realmente cancelar sua assinatura?')) return;
    const button = event.currentTarget;
    button.disabled = true;
    showBillingMessage('Cancelando assinatura...');
    try {
        await AppApi.request('/api/saas/cancel', { method: 'POST' });
        showBillingMessage('Assinatura cancelada.');
        await loadSubscription();
    } catch (error) {
        showBillingMessage(error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
        await AppApi.request('/api/saas/logout', { method: 'POST' });
    } catch (error) {
        console.error('Não foi possível encerrar a sessão no servidor:', error);
    } finally {
        window.location.assign('index.html');
    }
});

loadSubscription().catch((error) => {
    if (error.message.includes('Entre na sua conta')) {
        window.location.replace('entrar.html?tipo=dono');
        return;
    }
    document.getElementById('accountStore').textContent = 'Não foi possível carregar sua conta';
    document.getElementById('subscriptionStatus').textContent = 'Falha ao consultar';
    showBillingMessage(error.message, true);
    document.getElementById('checkoutButton').disabled = true;
});
