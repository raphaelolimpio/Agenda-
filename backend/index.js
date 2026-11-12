const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { createSaasBilling, effectiveSubscription } = require('./saas-billing');
const { isAllowedOrigin } = require('./origin-policy');
const { getUtcWeekday } = require('./date-utils');
const {
    appointmentBlocksProfessional,
    appointmentOverlaps,
    isBlockedPeriod
} = require('./schedule-utils');
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins);
if (process.env.NODE_ENV !== 'production') {
    ['4173', '5173', '5500', '5501', '8000', '8080'].forEach((port) => {
        allowedOrigins.add(`http://localhost:${port}`);
        allowedOrigins.add(`http://127.0.0.1:${port}`);
    });
}
app.use(cors({
    origin(origin, callback) {
        callback(null, isAllowedOrigin(origin, allowedOrigins));
    },
    credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
app.use((req, res, next) => {
    const origin = req.get('Origin');
    const isReadOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (origin && !isReadOnly && !isAllowedOrigin(origin, allowedOrigins)) {
        return res.status(403).json({ error: 'Origem não autorizada.' });
    }
    next();
});

// Conexão com o PostgreSQL
const pool = new Pool({
    ...require('./database-config').getDatabaseConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 10000,
    lock_timeout: 5000,
    statement_timeout: 15000
});
const frontendDirectory = path.join(__dirname, '..', 'frontend');
const saasBilling = createSaasBilling(app, pool, frontendDirectory);

let vitrineSchemaReady;

async function ensureVitrineSchema() {
    if (!vitrineSchemaReady) {
        vitrineSchemaReady = (async () => {
            await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracoes_vitrine (
                espaco_id BIGINT PRIMARY KEY,
                segmento TEXT NOT NULL DEFAULT 'outros',
                banner_url TEXT,
                descricao TEXT NOT NULL DEFAULT '',
                logo_url TEXT,
                cor_primaria CHAR(7) NOT NULL DEFAULT '#1246A0',
                cor_destaque CHAR(7) NOT NULL DEFAULT '#F97316',
                cor_fundo CHAR(7) NOT NULL DEFAULT '#F3F6FB',
                public_slug TEXT,
                instagram_handle TEXT,
                facebook_url TEXT,
                tiktok_url TEXT,
                youtube_url TEXT,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            `);
            await pool.query(`
                ALTER TABLE configuracoes_vitrine
                    ADD COLUMN IF NOT EXISTS public_slug TEXT,
                    ADD COLUMN IF NOT EXISTS instagram_handle TEXT,
                    ADD COLUMN IF NOT EXISTS facebook_url TEXT,
                    ADD COLUMN IF NOT EXISTS tiktok_url TEXT,
                    ADD COLUMN IF NOT EXISTS youtube_url TEXT
            `);
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS configuracoes_vitrine_public_slug_unique
                    ON configuracoes_vitrine (public_slug)
                    WHERE public_slug IS NOT NULL
            `);
        })().catch((error) => {
            vitrineSchemaReady = undefined;
            throw error;
        });
    }

    await vitrineSchemaReady;
}

function isValidSpaceId(value) {
    return /^\d+$/.test(value) && Number(value) > 0;
}

function isValidColor(value) {
    return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
}

function isValidOptionalUrl(value) {
    if (value === '' || value === null) return true;
    if (typeof value !== 'string' || value.length > 2048) return false;

    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

const reservedPublicSlugs = new Set([
    'admin', 'api', 'assinatura', 'agendar', 'cliente', 'colaborador',
    'entrar', 'espacos', 'index', 'marketplace', 'recuperar-senha',
    'status', 'vitrine'
]);

function isValidPublicSlug(value) {
    return typeof value === 'string'
        && value.length <= 60
        && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        && !reservedPublicSlugs.has(value);
}

function createPublicSlug(name, id) {
    const base = String(name || 'loja')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 44)
        .replace(/-+$/g, '') || 'loja';
    return `${base}-${id}`;
}

function normalizeInstagramHandle(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    const handle = value.trim().replace(/^@/, '');
    return handle === '' || /^[a-zA-Z0-9._]{1,30}$/.test(handle) ? handle : null;
}

app.get('/espacos', async (req, res) => {
    try {
        await ensureVitrineSchema();
        const result = await pool.query(`
            SELECT e.id, e.nome, e.nicho,
                   COALESCE(v.segmento, e.nicho, 'outros') AS segmento,
                   v.descricao, v.banner_url,
                   COALESCE((
                       SELECT STRING_AGG(s.nome, ' ')
                       FROM servicos s
                       WHERE s.espaco_id = e.id
                   ), '') AS servicos,
                   COALESCE(v.logo_url, e.logo_url) AS logo_url,
                   COALESCE(v.cor_primaria, '#1246A0') AS cor_primaria,
                   COALESCE(v.cor_destaque, '#F97316') AS cor_destaque,
                   COALESCE(v.cor_fundo, '#F3F6FB') AS cor_fundo,
                   v.public_slug
            FROM espacos e
            LEFT JOIN configuracoes_vitrine v ON v.espaco_id = e.id
            ORDER BY e.nome
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao listar espaços:', err);
        res.status(500).json({ error: 'Não foi possível carregar os estabelecimentos.' });
    }
});

app.get('/espacos/:id/vitrine', async (req, res) => {
    const { id } = req.params;
    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });

    try {
        await ensureVitrineSchema();
        const result = await pool.query(`
            SELECT e.id, e.nome, e.nicho,
                   COALESCE(v.segmento, e.nicho, 'outros') AS segmento,
                   COALESCE(v.descricao, '') AS descricao,
                   v.banner_url,
                   COALESCE(v.logo_url, e.logo_url) AS logo_url,
                   COALESCE(v.cor_primaria, '#1246A0') AS cor_primaria,
                   COALESCE(v.cor_destaque, '#F97316') AS cor_destaque,
                   COALESCE(v.cor_fundo, '#F3F6FB') AS cor_fundo,
                   v.public_slug, v.instagram_handle, v.facebook_url,
                   v.tiktok_url, v.youtube_url
            FROM espacos e
            LEFT JOIN configuracoes_vitrine v ON v.espaco_id = e.id
            WHERE e.id = $1
        `, [id]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
        const paymentSettings = await saasBilling.getPublicPaymentSettings(id);
        res.json({ ...result.rows[0], pix_key: paymentSettings.pix_key });
    } catch (err) {
        console.error('Erro ao buscar vitrine:', err);
        res.status(500).json({ error: 'Não foi possível carregar a vitrine.' });
    }
});

app.get('/api/public/vitrines/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!isValidPublicSlug(slug)) return res.status(404).json({ error: 'Vitrine não encontrada.' });

    try {
        await ensureVitrineSchema();
        const result = await pool.query(`
            SELECT e.id, e.nome, e.nicho,
                   COALESCE(v.segmento, e.nicho, 'outros') AS segmento,
                   COALESCE(v.descricao, '') AS descricao,
                   v.banner_url,
                   COALESCE(v.logo_url, e.logo_url) AS logo_url,
                   COALESCE(v.cor_primaria, '#1246A0') AS cor_primaria,
                   COALESCE(v.cor_destaque, '#F97316') AS cor_destaque,
                   COALESCE(v.cor_fundo, '#F3F6FB') AS cor_fundo,
                   v.public_slug, v.instagram_handle, v.facebook_url,
                   v.tiktok_url, v.youtube_url
            FROM configuracoes_vitrine v
            JOIN espacos e ON e.id = v.espaco_id
            WHERE v.public_slug = $1
        `, [slug]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Vitrine não encontrada.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao buscar vitrine pública:', err);
        res.status(500).json({ error: 'Não foi possível carregar a vitrine.' });
    }
});

app.put('/espacos/:id/vitrine', saasBilling.requireOwnedSpace(async (req, res) => {
    const { id } = req.params;
    let phase = 'validate';
    const startedAt = Date.now();
    const {
        segmento,
        banner_url,
        descricao,
        logo_url,
        cor_primaria,
        cor_destaque,
        cor_fundo,
        public_slug,
        instagram_handle,
        facebook_url,
        tiktok_url,
        youtube_url
    } = req.body;
    const requestedSlug = typeof public_slug === 'string' ? public_slug.trim().toLowerCase() : '';
    const normalizedInstagram = normalizeInstagramHandle(instagram_handle);

    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });
    if (typeof segmento !== 'string' || !segmento.trim() || segmento.length > 80) {
        return res.status(400).json({ error: 'Informe um segmento válido.' });
    }
    if (typeof descricao !== 'string' || descricao.length > 2000) {
        return res.status(400).json({ error: 'A descrição deve ter até 2.000 caracteres.' });
    }
    if (!isValidOptionalUrl(banner_url) || !isValidOptionalUrl(logo_url)) {
        return res.status(400).json({ error: 'As imagens devem usar endereços HTTP ou HTTPS válidos.' });
    }
    if (requestedSlug && !isValidPublicSlug(requestedSlug)) {
        return res.status(400).json({ error: 'Use um endereço com letras minúsculas, números e hífens, sem espaços ou acentos.' });
    }
    if (normalizedInstagram === null) {
        return res.status(400).json({ error: 'Informe um usuário válido do Instagram, sem incluir o endereço completo.' });
    }
    if (![facebook_url, tiktok_url, youtube_url].every((url) => isValidOptionalUrl(url === undefined ? '' : url))) {
        return res.status(400).json({ error: 'Os links sociais devem usar endereços HTTP ou HTTPS válidos.' });
    }
    if (![cor_primaria, cor_destaque, cor_fundo].every(isValidColor)) {
        return res.status(400).json({ error: 'Informe as três cores no formato hexadecimal #RRGGBB.' });
    }

    try {
        phase = 'vitrine_schema';
        await ensureVitrineSchema();
        phase = 'acquire_connection';
        const client = await pool.connect();
        let transactionStarted = false;
        let result;
        try {
            phase = 'begin_transaction';
            await client.query('BEGIN');
            transactionStarted = true;
            await client.query("SET LOCAL lock_timeout = '5s'");
            await client.query("SET LOCAL statement_timeout = '15s'");

            phase = 'check_space';
            const spaceResult = await client.query(`
                SELECT e.id, e.nome, v.public_slug, v.instagram_handle,
                       v.facebook_url, v.tiktok_url, v.youtube_url
                FROM espacos e
                LEFT JOIN configuracoes_vitrine v ON v.espaco_id = e.id
                WHERE e.id = $1
            `, [id]);
            if (spaceResult.rows.length === 0) {
                await client.query('ROLLBACK');
                transactionStarted = false;
                return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
            }

            const currentVitrine = spaceResult.rows[0];
            const publicSlug = requestedSlug || currentVitrine.public_slug || createPublicSlug(currentVitrine.nome, id);
            const savedInstagram = instagram_handle === undefined
                ? currentVitrine.instagram_handle || ''
                : normalizedInstagram || '';
            const savedFacebook = facebook_url === undefined ? currentVitrine.facebook_url || '' : facebook_url || '';
            const savedTikTok = tiktok_url === undefined ? currentVitrine.tiktok_url || '' : tiktok_url || '';
            const savedYouTube = youtube_url === undefined ? currentVitrine.youtube_url || '' : youtube_url || '';
            phase = 'save_vitrine';
            result = await client.query(`
                INSERT INTO configuracoes_vitrine
                    (espaco_id, segmento, banner_url, descricao, logo_url, cor_primaria, cor_destaque, cor_fundo,
                     public_slug, instagram_handle, facebook_url, tiktok_url, youtube_url, atualizado_em)
                VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7, $8, $9, NULLIF($10, ''),
                        NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NOW())
                ON CONFLICT (espaco_id) DO UPDATE SET
                    segmento = EXCLUDED.segmento,
                    banner_url = EXCLUDED.banner_url,
                    descricao = EXCLUDED.descricao,
                    logo_url = EXCLUDED.logo_url,
                    cor_primaria = EXCLUDED.cor_primaria,
                    cor_destaque = EXCLUDED.cor_destaque,
                    cor_fundo = EXCLUDED.cor_fundo,
                    public_slug = EXCLUDED.public_slug,
                    instagram_handle = EXCLUDED.instagram_handle,
                    facebook_url = EXCLUDED.facebook_url,
                    tiktok_url = EXCLUDED.tiktok_url,
                    youtube_url = EXCLUDED.youtube_url,
                    atualizado_em = NOW()
                RETURNING *
            `, [
                id,
                segmento.trim(),
                banner_url || '',
                descricao.trim(),
                logo_url || '',
                cor_primaria,
                cor_destaque,
                cor_fundo,
                publicSlug,
                savedInstagram,
                savedFacebook,
                savedTikTok,
                savedYouTube
            ]);

            phase = 'commit';
            await client.query('COMMIT');
            transactionStarted = false;
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    console.error('Vitrine update rollback failed:', rollbackError);
                }
            }
            throw error;
        } finally {
            client.release();
        }
        console.info('Vitrine update committed:', { space_id: id, duration_ms: Date.now() - startedAt });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar vitrine:', {
            space_id: id,
            phase,
            duration_ms: Date.now() - startedAt,
            code: err.code,
            message: err.message
        });
        const timedOut = ['57014', '55P03', 'ETIMEDOUT'].includes(err.code)
            || /timeout/i.test(err.message || '');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Este endereço público já está sendo usado por outra loja. Escolha outro.' });
        }
        res.status(timedOut ? 503 : 500).json({
            error: timedOut
                ? 'O banco de dados está ocupado. Nenhuma alteração foi confirmada; tente novamente em instantes.'
                : 'Não foi possível salvar as configurações da vitrine.'
        });
    }
}));

app.get('/espacos/:id/servicos', async (req, res) => {
    const { id } = req.params;
    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });

    try {
        res.json(await saasBilling.getPublicServicesForSpace(id));
    } catch (err) {
        console.error('Erro ao buscar serviços:', err);
        res.status(500).json({ error: 'Não foi possível carregar os serviços.' });
    }
});

// Rota de Teste de Conexão
app.get('/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ status: 'Conectado com sucesso!', time: result.rows[0].now });
    } catch (err) {
        console.error('Erro ao verificar conexão com banco:', err);
        res.status(500).json({ error: 'Não foi possível conectar ao banco de dados.' });
    }
});

// 1. MOTOR DE CÁLCULO DE HORÁRIOS LIVRES (GET)
app.get('/espacos/:id/horarios-disponiveis', async (req, res) => {
    const { id } = req.params;
    const { data, servico_id } = req.query; // Ex: ?data=2026-11-05&servico_id=1
    const diaSemana = getUtcWeekday(data);
    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });
    if (diaSemana === null) return res.status(400).json({ error: 'Data inválida.' });
    if (!/^\d+$/.test(String(servico_id || ''))) return res.status(400).json({ error: 'Serviço inválido.' });
    const professionalId = req.query.profissional_id ? String(req.query.profissional_id) : '';
    const professionalType = req.query.profissional_tipo ? String(req.query.profissional_tipo) : '';
    if ((professionalId || professionalType)
        && (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(professionalId)
            || !['owner', 'employee'].includes(professionalType))) {
        return res.status(400).json({ error: 'Profissional inválido.' });
    }

    try {
        const services = await saasBilling.getPublicServicesForSpace(id);
        const service = services.find((item) => String(item.id) === String(servico_id));
        if (!service) return res.status(404).json({ error: 'Serviço não encontrado' });
        const selectedProfessional = professionalId
            ? service.profissionais.find((item) =>
                item.type === professionalType && item.id.toLowerCase() === professionalId.toLowerCase())
            : null;
        if (professionalId && !selectedProfessional) {
            return res.status(400).json({ error: 'Este profissional não está vinculado ao serviço.' });
        }
        const duration = Number(service.duracao_minutos);
        const configRes = await pool.query(
            'SELECT hora_inicio, hora_fim, ativo FROM configuracoes_horarios WHERE espaco_id = $1 AND dia_semana = $2',
            [id, diaSemana]
        );
        if (configRes.rows.length === 0) {
            return res.json({
                horarios_livres: [],
                mensagem: 'Os horários de funcionamento ainda não foram configurados para este dia.'
            });
        }
        if (!configRes.rows[0].ativo) {
            return res.json({ horarios_livres: [], mensagem: 'O estabelecimento não atende neste dia.' });
        }

        if (!Number.isInteger(duration) || duration < 1) {
            return res.status(500).json({ error: 'A duração configurada para o serviço é inválida.' });
        }

        const { hora_inicio: openingTime, hora_fim: closingTime } = configRes.rows[0];
        const openingMinutes = Number(String(openingTime).slice(0, 2)) * 60 + Number(String(openingTime).slice(3, 5));
        const closingMinutes = Number(String(closingTime).slice(0, 2)) * 60 + Number(String(closingTime).slice(3, 5));
        const professionals = selectedProfessional
            ? [selectedProfessional]
            : service.profissionais.length ? service.profissionais : [null];
        const blocksByProfessional = await Promise.all(professionals.map((professional) =>
            saasBilling.getScheduleBlocksForSpace(
                id,
                professional?.type === 'employee' ? professional.id : null
            )));
        const appointmentsByProfessional = await Promise.all(professionals.map(async (professional) => {
            const storeResult = await pool.query(`
                SELECT espaco_id AS space_id,
                       data_hora_inicio::date::text AS local_date,
                       data_hora_fim::date::text AS end_date,
                       to_char(data_hora_inicio, 'HH24:MI') AS start_time,
                       to_char(data_hora_fim, 'HH24:MI') AS end_time,
                       saas_professional_type, saas_professional_id
                FROM agendamentos
                WHERE espaco_id = $1
                  AND data_hora_inicio < ($2::date + INTERVAL '1 day')
                  AND data_hora_fim > $2::date
                  AND status IN ('confirmado', 'agendado', 'pago')
            `, [id, data]);
            let appointments = storeResult.rows;
            if (professional?.type === 'employee') {
                const otherSpacesResult = await pool.query(`
                    SELECT espaco_id AS space_id,
                           data_hora_inicio::date::text AS local_date,
                           data_hora_fim::date::text AS end_date,
                           to_char(data_hora_inicio, 'HH24:MI') AS start_time,
                           to_char(data_hora_fim, 'HH24:MI') AS end_time,
                           saas_professional_type, saas_professional_id
                    FROM agendamentos
                    WHERE espaco_id <> $1
                      AND saas_professional_type = 'employee'
                      AND saas_professional_id = $2
                      AND data_hora_inicio < ($3::date + INTERVAL '1 day')
                      AND data_hora_fim > $3::date
                      AND status IN ('confirmado', 'agendado', 'pago')
                `, [id, professional.id, data]);
                appointments = appointments.concat(otherSpacesResult.rows);
            }
            return appointments;
        }));

        const slotsSet = new Set();
        professionals.forEach((professional, professionalIndex) => {
            for (let startMinutes = openingMinutes; startMinutes + duration <= closingMinutes; startMinutes += duration) {
                const endMinutes = startMinutes + duration;
                const startTime = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
                const blocked = isBlockedPeriod(blocksByProfessional[professionalIndex], data, startMinutes, endMinutes);
                if (blocked) continue;

                const hasConflict = appointmentsByProfessional[professionalIndex].some((appointment) => {
                    return appointmentBlocksProfessional(appointment, professional, id)
                        && appointmentOverlaps(data, startMinutes, endMinutes, appointment);
                });
                if (!hasConflict) slotsSet.add(startTime);
            }
        });
        const slotsLivres = [...slotsSet].sort();

        res.json({
            data,
            servico_id,
            profissional_id: selectedProfessional?.id || null,
            profissional_tipo: selectedProfessional?.type || null,
            horarios_livres: slotsLivres
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao calcular horários livres.' });
    }
});

app.post('/espacos/:id/agendamentos', async (req, res) => {
    const { id } = req.params;
    const {
        servico_id: serviceId,
        data,
        horario,
        forma_pagamento: paymentMethod,
        timezone_offset_minutes: timezoneOffset
    } = req.body || {};
    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });
    if (!/^\d+$/.test(String(serviceId || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(data || '')
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horario || '')
    || !['local', 'pix'].includes(paymentMethod)
    || !Number.isInteger(timezoneOffset) || Math.abs(timezoneOffset) > 840) {
        return res.status(400).json({ error: 'Selecione um serviço, data e horário válidos.' });
    }
    const professionalId = typeof req.body.profissional_id === 'string' ? req.body.profissional_id.toLowerCase() : '';
    const professionalType = typeof req.body.profissional_tipo === 'string' ? req.body.profissional_tipo : '';
    if ((professionalId || professionalType)
        && (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(professionalId)
            || !['owner', 'employee'].includes(professionalType))) {
        return res.status(400).json({ error: 'Selecione um profissional válido.' });
    }
    if (getUtcWeekday(data) === null) {
        return res.status(400).json({ error: 'Escolha uma data válida.' });
    }

    let customer;
    try {
        customer = await saasBilling.getCustomerForRequest(req);
    } catch (error) {
        console.error('Appointment customer validation failed:', error);
        return res.status(500).json({ error: 'Não foi possível validar sua conta de cliente.' });
    }
    if (!customer) return res.status(401).json({ error: 'Entre na sua conta de cliente para confirmar o atendimento.' });

    const [year, month, day] = data.split('-').map(Number);
    const [hour, minute] = horario.split(':').map(Number);
    const requestedDateTime = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (requestedDateTime.getUTCFullYear() !== year
        || requestedDateTime.getUTCMonth() !== month - 1
        || requestedDateTime.getUTCDate() !== day) {
        return res.status(400).json({ error: 'Escolha uma data válida.' });
    }
    const startsAt = new Date(requestedDateTime.getTime() + timezoneOffset * 60_000);
    if (startsAt <= new Date()) {
        return res.status(400).json({ error: 'Escolha uma data e horário futuros.' });
    }
    const startTimestamp = `${data} ${horario}:00`;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${id}:${data}`]);
        if (professionalId && professionalType === 'employee') {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`employee:${professionalId}:${data}`]);
        }

        const ownerSubscription = await client.query(`
            SELECT s.provider_status, s.trial_ends_at, s.next_payment_at
            FROM saas_subscriptions s
            JOIN saas_accounts a ON a.id = s.account_id
            WHERE a.space_id = $1
        `, [id]);
        if (ownerSubscription.rows[0] && !effectiveSubscription(ownerSubscription.rows[0]).can_access) {
            await client.query('ROLLBACK');
            return res.status(402).json({ error: 'Este estabelecimento está temporariamente indisponível.' });
        }

        const serviceResult = await client.query(
            'SELECT id, duracao_minutos, preco FROM servicos WHERE id = $1 AND espaco_id = $2',
            [serviceId, id]
        );
        if (serviceResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Serviço não encontrado neste estabelecimento.' });
        }
        if (paymentMethod === 'pix') {
            const paymentSettings = await client.query(
                'SELECT pix_key FROM saas_accounts WHERE space_id = $1',
                [id]
            );
            if (!paymentSettings.rows[0]?.pix_key) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'A loja ainda não configurou uma chave PIX. Escolha pagar no local.' });
            }
        }
        const professionalResult = await client.query(`
            SELECT professional_id AS id, professional_type AS type
            FROM saas_service_professionals
            WHERE space_id = $1 AND service_id = $2
        `, [id, String(serviceId)]);
        const serviceProfessionals = professionalResult.rows;
        if (serviceProfessionals.length && !professionalId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Escolha o profissional que realizará este serviço.' });
        }
        const professional = professionalId
            ? serviceProfessionals.find((item) =>
                item.type === professionalType && item.id.toLowerCase() === professionalId.toLowerCase())
            : null;
        if (professionalId && !professional) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Este profissional não está vinculado ao serviço.' });
        }

        const weekday = getUtcWeekday(data);
        const hoursResult = await client.query(`
            SELECT hora_inicio, hora_fim, ativo
            FROM configuracoes_horarios
            WHERE espaco_id = $1 AND dia_semana = $2
        `, [id, weekday]);
        const hours = hoursResult.rows[0];
        if (!hours) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Os horários de funcionamento ainda não foram configurados para este dia.' });
        }
        if (!hours.ativo) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'O estabelecimento não atende neste dia.' });
        }

        const duration = Number(serviceResult.rows[0].duracao_minutos);
        const [startHour, startMinute] = horario.split(':').map(Number);
        const [closeHour, closeMinute] = String(hours.hora_fim).slice(0, 5).split(':').map(Number);
        const [openHour, openMinute] = String(hours.hora_inicio).slice(0, 5).split(':').map(Number);
        const startMinutes = startHour * 60 + startMinute;
        const closeMinutes = closeHour * 60 + closeMinute;
        const openMinutes = openHour * 60 + openMinute;
        const endMinutes = startMinutes + duration;
        if (!Number.isFinite(duration) || duration < 1
            || startMinutes < openMinutes
            || (startMinutes - openMinutes) % duration !== 0
            || endMinutes > closeMinutes) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'O horário escolhido está fora do expediente.' });
        }

        const scheduleBlocks = await saasBilling.getScheduleBlocksForSpace(
            id,
            professional?.type === 'employee' ? professional.id : null,
            client
        );
        if (isBlockedPeriod(scheduleBlocks, data, startMinutes, endMinutes)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Esse horário está bloqueado. Escolha outro horário.' });
        }

        const conflictResult = await client.query(`
            SELECT EXISTS (
                SELECT 1
                FROM agendamentos
                WHERE status IN ('confirmado', 'agendado', 'pago')
                  AND data_hora_inicio < ($2::timestamp + ($3 * INTERVAL '1 minute'))
                  AND data_hora_fim > $2::timestamp
                  AND (
                      (
                          espaco_id = $1
                          AND (
                              $4::uuid IS NULL
                              OR saas_professional_id IS NULL
                              OR (saas_professional_type = $5 AND saas_professional_id = $4::uuid)
                          )
                      )
                      OR (
                          $5 = 'employee'
                          AND espaco_id <> $1
                          AND saas_professional_type = 'employee'
                          AND saas_professional_id = $4::uuid
                      )
                  )
            ) AS has_conflict
        `, [id, startTimestamp, duration, professional?.id || null, professional?.type || null]);
        if (conflictResult.rows[0].has_conflict) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Esse horário acabou de ser reservado. Escolha outro horário.' });
        }

        const appointmentResult = await client.query(`
            INSERT INTO agendamentos
                (espaco_id, servico_id, cliente_nome, cliente_telefone, data_hora_inicio, data_hora_fim, status,
                 saas_cliente_id, saas_professional_type, saas_professional_id, forma_pagamento, valor_servico)
            VALUES (
                $1, $2, $3, $4, $5::timestamp,
                $5::timestamp + ($6 * INTERVAL '1 minute'), 'confirmado', $7, $8, $9, $10, $11
            )
            RETURNING id, espaco_id, servico_id, data_hora_inicio, data_hora_fim, status, forma_pagamento
        `, [
            id,
            serviceId,
            customer.full_name,
            customer.phone,
            startTimestamp,
            duration,
            customer.id,
            professional?.type || null,
            professional?.id || null,
            paymentMethod,
            serviceResult.rows[0].preco
        ]);
        await client.query('COMMIT');
        return res.status(201).json({
            message: paymentMethod === 'pix'
                ? 'Horário reservado. O pagamento via PIX ainda precisa ser feito e confirmado pela loja.'
                : 'Horário reservado. O pagamento será feito no local.',
            appointment: {
                ...appointmentResult.rows[0],
                valor: Number(serviceResult.rows[0].preco) || 0,
                pagamento_status: 'pendente'
            }
        });
    } catch (error) {
        await client.query('ROLLBACK').catch((rollbackError) => {
            console.error('Appointment booking rollback failed:', rollbackError);
        });
        console.error('Appointment booking failed:', error);
        return res.status(500).json({ error: 'Não foi possível confirmar o atendimento.' });
    } finally {
        client.release();
    }
});

// 2. ROTA DO CHATBOT INTELIGENTE (POST) - AGORA FORA DA OUTRA ROTA
// 2. ROTA DO CHATBOT INTELIGENTE E REGISTRO DE AGENDAMENTO (POST)
app.post('/espacos/:id/chat', async (req, res) => {
    const { id } = req.params;
    const { historicoMensagens, mensagemCliente } = req.body;

    try {
        const configBotRes = await pool.query('SELECT * FROM configuracoes_chatbot WHERE espaco_id = $1', [id]);
        const servicosRes = await pool.query('SELECT id, nome, duracao_minutos, preco FROM servicos WHERE espaco_id = $1', [id]);
        const espacoRes = await pool.query('SELECT nome, nicho FROM espacos WHERE id = $1', [id]);

        if (espacoRes.rows.length === 0) {
            return res.status(404).json({ error: 'Espaço não encontrado' });
        }

        const espaco = espacoRes.rows[0];
        const configBot = configBotRes.rows[0] || {
            tom_voz: 'amigável',
            instrucoes_extras: 'Seja prestativo.',
            mensagem_boas_vindas: 'Olá! Como posso ajudar no seu agendamento?'
        };
        const servicosDisponiveis = servicosRes.rows;

        const systemInstruction = `
      Você é o assistente virtual de agendamentos do estabelecimento "${espaco.nome}" (Nicho: ${espaco.nicho}).
      Seu objetivo é conversar com o cliente de forma natural, descobrir qual serviço ele deseja, qual a data e horário pretendidos, além do nome e telefone do cliente para fechar o agendamento.
      
      Diretrizes de comportamento:
      - Tom de voz: ${configBot.tom_voz}.
      - Instruções adicionais do dono: ${configBot.instrucoes_extras}
      
      Serviços oferecidos por este estabelecimento:
      ${JSON.stringify(servicosDisponiveis, null, 2)}

      REGRA CRÍTICA PARA FINALIZAÇÃO:
      Assim que o cliente tiver escolhido o serviço, a data, o horário exato, informado o NOME dele e o TELEFONE, você DEVE retornar a resposta final para o cliente confirmando o agendamento e, no final da sua resposta, incluir estritamente um bloco JSON oculto ou formatado exatamente neste padrão para que o sistema consiga salvar no banco:
      [AGENDAMENTO_JSON: {"servico_id": ID_DO_SERVICO, "cliente_nome": "NOME", "cliente_telefone": "TELEFONE", "data_hora_inicio": "AAAA-MM-DD HH:MM:SS"}]
    `;

        const contents = [
            ...(historicoMensagens || []),
            { role: 'user', parts: [{ text: mensagemCliente }] }
        ];

        const ai = new GoogleGenAI();
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.7,
            }
        });

        let respostaTexto = response.text;

        // Verificar se a IA decidiu concluir e gerou a tag de agendamento
        const regexAgendamento = /\[AGENDAMENTO_JSON:\s*({.*?})\]/;
        const match = respostaTexto.match(regexAgendamento);

        if (match) {
            try {
                const dadosAgendamento = JSON.parse(match[1]);
                const cliente = await saasBilling.getCustomerForRequest(req);
                
                // 1. Buscar duração do serviço para calcular o horário de fim
                const servRes = await pool.query(
                    'SELECT duracao_minutos FROM servicos WHERE id = $1 AND espaco_id = $2',
                    [dadosAgendamento.servico_id, id]
                );
                if (servRes.rows.length === 0) throw new Error('Serviço não encontrado para este estabelecimento.');
                const duracao = servRes.rows[0].duracao_minutos;

                const inicioDate = new Date(dadosAgendamento.data_hora_inicio);
                const fimDate = new Date(inicioDate.getTime() + duracao * 60000);
                const dataHoraFimStr = fimDate.toISOString().slice(0, 19).replace('T', ' ');

                // 2. Salvar no Banco de Dados
                await pool.query(
                    `INSERT INTO agendamentos
                        (espaco_id, servico_id, cliente_nome, cliente_telefone, data_hora_inicio, data_hora_fim, status, saas_cliente_id)
                     VALUES ($1, $2, $3, $4, $5, $6, 'confirmado', $7)`,
                    [
                        id,
                        dadosAgendamento.servico_id,
                        dadosAgendamento.cliente_nome,
                        dadosAgendamento.cliente_telefone,
                        dadosAgendamento.data_hora_inicio,
                        dataHoraFimStr,
                        cliente?.id || null
                    ]
                );

                // Remover o JSON técnico da resposta que vai aparecer para o usuário
                respostaTexto = respostaTexto.replace(regexAgendamento, '').trim();
                respostaTexto += "\n\n✅ *Agendamento confirmado e salvo com sucesso em nosso sistema!*";

                // (Opcional Futuro): Aqui você poderá disparar a função de envio de WhatsApp/E-mail

            } catch (errDb) {
                console.error("Erro ao salvar agendamento gerado pela IA:", errDb);
            }
        }

        res.json({
            resposta: respostaTexto,
            historicoAtualizado: [
                ...contents,
                { role: 'model', parts: [{ text: respostaTexto }] }
            ]
        });

    } catch (err) {
        console.error('Erro no chatbot:', err);
        res.status(500).json({ error: 'Erro ao processar a mensagem no chatbot.' });
    }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(frontendDirectory));

const subscriptionSweep = setInterval(() => {
    saasBilling.cancelOverdueSubscriptions().catch((error) => {
        console.error('Overdue subscription sweep failed:', error);
    });
}, 5 * 60 * 1000);
subscriptionSweep.unref();
saasBilling.cancelOverdueSubscriptions().catch((error) => {
    console.error('Initial overdue subscription sweep failed:', error);
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});