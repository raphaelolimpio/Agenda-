const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
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
        callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    const origin = req.get('Origin');
    const isReadOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (origin && !isReadOnly && !allowedOrigins.has(origin)) {
        return res.status(403).json({ error: 'Origem não autorizada.' });
    }
    next();
});

// Conexão com o PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? {
            rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
            ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA } : {})
        }
        : undefined
});
const frontendDirectory = path.join(__dirname, '..', 'frontend');
const saasBilling = require('./saas-billing').createSaasBilling(app, pool, frontendDirectory);

let vitrineSchemaReady;

async function ensureVitrineSchema() {
    if (!vitrineSchemaReady) {
        vitrineSchemaReady = pool.query(`
            CREATE TABLE IF NOT EXISTS configuracoes_vitrine (
                espaco_id BIGINT PRIMARY KEY,
                segmento TEXT NOT NULL DEFAULT 'outros',
                banner_url TEXT,
                descricao TEXT NOT NULL DEFAULT '',
                logo_url TEXT,
                cor_primaria CHAR(7) NOT NULL DEFAULT '#1246A0',
                cor_destaque CHAR(7) NOT NULL DEFAULT '#F97316',
                cor_fundo CHAR(7) NOT NULL DEFAULT '#F3F6FB',
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `).catch((error) => {
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
                   COALESCE(v.cor_fundo, '#F3F6FB') AS cor_fundo
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
                   COALESCE(v.cor_fundo, '#F3F6FB') AS cor_fundo
            FROM espacos e
            LEFT JOIN configuracoes_vitrine v ON v.espaco_id = e.id
            WHERE e.id = $1
        `, [id]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao buscar vitrine:', err);
        res.status(500).json({ error: 'Não foi possível carregar a vitrine.' });
    }
});

app.put('/espacos/:id/vitrine', saasBilling.requireOwnedSpace, async (req, res) => {
    const { id } = req.params;
    const {
        segmento,
        banner_url,
        descricao,
        logo_url,
        cor_primaria,
        cor_destaque,
        cor_fundo
    } = req.body;

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
    if (![cor_primaria, cor_destaque, cor_fundo].every(isValidColor)) {
        return res.status(400).json({ error: 'Informe as três cores no formato hexadecimal #RRGGBB.' });
    }

    try {
        await ensureVitrineSchema();
        const spaceResult = await pool.query('SELECT id FROM espacos WHERE id = $1', [id]);
        if (spaceResult.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });

        const result = await pool.query(`
            INSERT INTO configuracoes_vitrine
                (espaco_id, segmento, banner_url, descricao, logo_url, cor_primaria, cor_destaque, cor_fundo, atualizado_em)
            VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, $7, $8, NOW())
            ON CONFLICT (espaco_id) DO UPDATE SET
                segmento = EXCLUDED.segmento,
                banner_url = EXCLUDED.banner_url,
                descricao = EXCLUDED.descricao,
                logo_url = EXCLUDED.logo_url,
                cor_primaria = EXCLUDED.cor_primaria,
                cor_destaque = EXCLUDED.cor_destaque,
                cor_fundo = EXCLUDED.cor_fundo,
                atualizado_em = NOW()
            RETURNING *
        `, [id, segmento.trim(), banner_url || '', descricao.trim(), logo_url || '', cor_primaria, cor_destaque, cor_fundo]);

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar vitrine:', err);
        res.status(500).json({ error: 'Não foi possível salvar as configurações da vitrine.' });
    }
});

app.get('/espacos/:id/servicos', async (req, res) => {
    const { id } = req.params;
    if (!isValidSpaceId(id)) return res.status(400).json({ error: 'ID de estabelecimento inválido.' });

    try {
        const result = await pool.query(`
            SELECT id, nome, categoria, duracao_minutos, preco
            FROM servicos
            WHERE espaco_id = $1
            ORDER BY nome
        `, [id]);
        res.json(result.rows);
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

    try {
        const servicoRes = await pool.query('SELECT duracao_minutos FROM servicos WHERE id = $1', [servico_id]);
        if (servicoRes.rows.length === 0) return res.status(404).json({ error: 'Serviço não encontrado' });
        const duracaoMinutos = servicoRes.rows[0].duracao_minutos;

        const dataObj = new Date(data);
        const diaSemana = dataObj.getDay();

        const configRes = await pool.query(
            'SELECT hora_inicio, hora_fim, ativo FROM configuracoes_horarios WHERE espaco_id = $1 AND dia_semana = $2',
            [id, diaSemana]
        );

        if (configRes.rows.length === 0 || !configRes.rows[0].ativo) {
            return res.json({ horarios_livres: [], mensagem: 'Estabelecimento fechado neste dia.' });
        }

        const { hora_inicio, hora_fim } = configRes.rows[0];

        const inicioDia = `${data} 00:00:00`;
        const fimDia = `${data} 23:59:59`;
        const agendamentosRes = await pool.query(
            'SELECT data_hora_inicio, data_hora_fim FROM agendamentos WHERE espaco_id = $1 AND data_hora_inicio BETWEEN $2 AND $3 AND status = $4',
            [id, inicioDia, fimDia, 'confirmado']
        );
        const agendamentos = agendamentosRes.rows;

        let slotsLivres = [];
        let [horaAtualH, horaAtualM] = hora_inicio.split(':').map(Number);
        const [horaFimH, horaFimM] = hora_fim.split(':').map(Number);

        while (horaAtualH < horaFimH || (horaAtualH === horaFimH && horaAtualM < horaFimM)) {
            let slotInicioStr = `${String(horaAtualH).padStart(2, '0')}:${String(horaAtualM).padStart(2, '0')}`;

            let totalMinutosInicio = horaAtualH * 60 + horaAtualM + duracaoMinutos;
            let slotFimH = Math.floor(totalMinutosInicio / 60);
            let slotFimM = totalMinutosInicio % 60;

            let slotFimStr = `${String(slotFimH).padStart(2, '0')}:${String(slotFimM).padStart(2, '0')}`;

            if (slotFimH > horaFimH || (slotFimH === horaFimH && slotFimM > horaFimM)) {
                break;
            }

            let slotInicioDate = new Date(`${data} ${slotInicioStr}:00`);
            let slotFimDate = new Date(`${data} ${slotFimStr}:00`);

            let temConflito = agendamentos.some(ag => {
                let agInicio = new Date(ag.data_hora_inicio);
                let agFim = new Date(ag.data_hora_fim);
                return slotInicioDate < agFim && slotFimDate > agInicio;
            });

            if (!temConflito) {
                slotsLivres.push(slotInicioStr);
            }

            horaAtualM += duracaoMinutos;
            if (horaAtualM >= 60) {
                horaAtualH += Math.floor(horaAtualM / 60);
                horaAtualM = horaAtualM % 60;
            }
        }

        res.json({ data, servico_id, horarios_livres: slotsLivres });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao calcular horários livres.' });
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
                
                // 1. Buscar duração do serviço para calcular o horário de fim
                const servRes = await pool.query('SELECT duracao_minutos FROM servicos WHERE id = $1', [dadosAgendamento.servico_id]);
                const duracao = servRes.rows[0].duracao_minutos;

                const inicioDate = new Date(dadosAgendamento.data_hora_inicio);
                const fimDate = new Date(inicioDate.getTime() + duracao * 60000);
                const dataHoraFimStr = fimDate.toISOString().slice(0, 19).replace('T', ' ');

                // 2. Salvar no Banco de Dados
                await pool.query(
                    `INSERT INTO agendamentos (espaco_id, servico_id, cliente_nome, cliente_telefone, data_hora_inicio, data_hora_fim, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'confirmado')`,
                    [
                        id,
                        dadosAgendamento.servico_id,
                        dadosAgendamento.cliente_nome,
                        dadosAgendamento.cliente_telefone,
                        dadosAgendamento.data_hora_inicio,
                        dataHoraFimStr
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

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});