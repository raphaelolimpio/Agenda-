const previewOriginPattern = /^https:\/\/agenda-frontend-(?:phi|[a-z0-9-]+-raphaelolimpios-projects)\.vercel\.app$/;

function isAllowedOrigin(origin, allowedOrigins) {
    return !origin || allowedOrigins.has(origin) || previewOriginPattern.test(origin);
}

module.exports = { isAllowedOrigin };
