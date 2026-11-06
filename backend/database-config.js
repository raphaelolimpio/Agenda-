function getDatabaseConfig(connectionString, env = process.env) {
    if (typeof connectionString !== 'string' || !connectionString) {
        throw new Error('DATABASE_URL must be configured.');
    }

    const databaseUrl = new URL(connectionString);
    const usesRailwayPublicProxy = databaseUrl.hostname === 'proxy.rlwy.net'
        || databaseUrl.hostname.endsWith('.proxy.rlwy.net');
    if (env.NODE_ENV !== 'production' && !usesRailwayPublicProxy) {
        return { connectionString };
    }

    const sslOverride = env.DATABASE_SSL_REJECT_UNAUTHORIZED;
    const rejectUnauthorized = sslOverride === 'true'
        ? true
        : sslOverride === 'false'
            ? false
            : !usesRailwayPublicProxy;

    for (const parameter of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) {
        databaseUrl.searchParams.delete(parameter);
    }

    return {
        connectionString: databaseUrl.toString(),
        ssl: {
            rejectUnauthorized,
            ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : {})
        }
    };
}

module.exports = { getDatabaseConfig };
