(function () {
    const developmentPorts = ['4173', '5173', '5500', '5501', '8000', '8080'];
    const isLocalFrontend = window.location.protocol === 'file:'
        || (['localhost', '127.0.0.1'].includes(window.location.hostname)
            && developmentPorts.includes(window.location.port));
    // Keep empty on Vercel to use vercel.json proxy rewrites and same-site session cookies.
    const configuredApiUrl = window.API_URL || window.APP_API_BASE_URL;

    window.API_URL = (configuredApiUrl || (isLocalFrontend ? 'http://localhost:3000' : ''))
        .replace(/\/+$/, '');
})();
