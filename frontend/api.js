(function () {
    const apiBase = window.API_URL || '';

    async function request(path, options = {}) {
        const response = await fetch(`${apiBase}${path}`, {
            ...options,
            credentials: 'include',
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers
            }
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(payload.error || `Falha na solicitação (${response.status}).`);
        }

        return payload;
    }

    function getSpaceId() {
        const requestedId = new URLSearchParams(window.location.search).get('loja');
        const savedId = window.localStorage.getItem('espacoId');
        return requestedId || savedId || '1';
    }

    function applyBrandTheme(settings) {
        const root = document.documentElement;
        if (settings.cor_primaria) root.style.setProperty('--brand-primary', settings.cor_primaria);
        if (settings.cor_destaque) root.style.setProperty('--brand-accent', settings.cor_destaque);
        if (settings.cor_fundo) root.style.setProperty('--brand-background', settings.cor_fundo);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    window.AppApi = {
        request,
        getSpaceId,
        setSpaceId(value) {
            window.localStorage.setItem('espacoId', String(value));
        },
        applyBrandTheme,
        escapeHtml
    };
})();
