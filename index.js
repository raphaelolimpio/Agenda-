// Listar serviços do espaço
app.get('/espacos/:id/servicos', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM servicos WHERE espaco_id = $1', [id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar serviços' });
    }
});

// Cadastrar novo serviço
app.post('/espacos/:id/servicos', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, duracao_minutos, preco } = req.body;
        const result = await pool.query(
            'INSERT INTO servicos (espaco_id, nome, duracao_minutos, preco) VALUES ($1, $2, $3, $4) RETURNING *',
            [id, nome, duracao_minutos, preco]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao cadastrar serviço' });
    }
});

app.get('/espacos/:id/agenda', async (req, res) => {
    const { id } = req.params;
    const { filtro, data_referencia, colaborador_id } = req.query; 
    // filtro: 'dia', 'semana', 'mes', 'ano' | data_referencia: '2026-10-31'

    try {
        let condicaoData = '';
        if (filtro === 'dia') {
            condicaoData = `DATE(a.data_hora_inicio) = '${data_referencia}'`;
        } else if (filtro === 'semana') {
            condicaoData = `DATE_PART('week', a.data_hora_inicio) = DATE_PART('week', TIMESTAMP '${data_referencia}') 
                            AND DATE_PART('year', a.data_hora_inicio) = DATE_PART('year', TIMESTAMP '${data_referencia}')`;
        } else if (filtro === 'mes') {
            condicaoData = `DATE_PART('month', a.data_hora_inicio) = DATE_PART('month', TIMESTAMP '${data_referencia}') 
                            AND DATE_PART('year', a.data_hora_inicio) = DATE_PART('year', TIMESTAMP '${data_referencia}')`;
        } else if (filtro === 'ano') {
            condicaoData = `DATE_PART('year', a.data_hora_inicio) = DATE_PART('year', TIMESTAMP '${data_referencia}')`;
        } else {
            condicaoData = `DATE(a.data_hora_inicio) = CURRENT_DATE`;
        }

        let params = [id];
        let filtroColab = '';
        if (colaborador_id) {
            params.push(colaborador_id);
            filtroColab = `AND a.colaborador_id = $2`;
        }

        const query = `
            SELECT 
                a.id, a.data_hora_inicio, a.data_hora_fim, a.status, 
                a.status_pagamento, a.forma_pagamento, a.tipo_atendimento, a.valor_cobrado,
                COALESCE(c.nome, a.cliente_nome) AS cliente_nome,
                COALESCE(c.telefone_whatsapp, a.cliente_telefone) AS cliente_telefone,
                s.nome AS servico_nome, s.categoria AS servico_categoria,
                col.nome AS colaborador_nome
            FROM agendamentos a
            LEFT JOIN clientes c ON a.cliente_id = c.id
            LEFT JOIN servicos s ON a.servico_id = s.id
            LEFT JOIN colaboradores col ON a.colaborador_id = col.id
            WHERE a.espaco_id = $1 AND ${condicaoData} ${filtroColab}
            ORDER BY a.data_hora_inicio ASC
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao carregar agenda filtrada.' });
    }
});

app.get('/agendamentos/:agendamento_id/detalhes', async (req, res) => {
    const { agendamento_id } = req.params;
    try {
        const result = await pool.query(`
            SELECT a.*, s.nome AS servico_nome, col.nome AS colaborador_nome,
            (SELECT COUNT(*) FROM agendamentos prev WHERE prev.cliente_telefone = a.cliente_telefone AND prev.status = 'concluido') AS total_visitas_anteriores
            FROM agendamentos a
            LEFT JOIN servicos s ON a.servico_id = s.id
            LEFT JOIN colaboradores col ON a.colaborador_id = col.id
            WHERE a.id = $1
        `, [agendamento_id]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Agendamento não encontrado' });
        
        const dados = result.rows[0];
        dados.cliente_recorrente = Number(dados.total_visitas_anteriores) > 0;
        res.json(dados);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar detalhes do agendamento.' });
    }
});

app.put('/agendamentos/:agendamento_id/remarcar', async (req, res) => {
    const { agendamento_id } = req.params;
    const { nova_data_hora_inicio } = req.body;

    try {
        const agRes = await pool.query(`
            SELECT a.*, s.duracao_minutos, s.nome AS servico_nome, e.nome AS espaco_nome 
            FROM agendamentos a 
            JOIN servicos s ON a.servico_id = s.id 
            JOIN espacos e ON a.espaco_id = e.id
            WHERE a.id = $1
        `, [agendamento_id]);

        if (agRes.rows.length === 0) return res.status(404).json({ error: 'Agendamento não encontrado' });
        const ag = agRes.rows[0];

        const inicioDate = new Date(nova_data_hora_inicio);
        const fimDate = new Date(inicioDate.getTime() + ag.duracao_minutos * 60000);
        const novaDataHoraFim = fimDate.toISOString().slice(0, 19).replace('T', ' ');

        await pool.query(
            'UPDATE agendamentos SET data_hora_inicio = $1, data_hora_fim = $2 WHERE id = $3',
            [nova_data_hora_inicio, novaDataHoraFim, agendamento_id]
        );

        // Simulação de disparo para API de WhatsApp (Z-API / Evolution API)
        const msgWhatsApp = `Olá ${ag.cliente_nome}! Seu agendamento de *${ag.servico_nome}* no *${ag.espaco_nome}* foi remarcado para: *${nova_data_hora_inicio}*.`;
        console.log(`[WHATSAPP ENVIADO PARA ${ag.cliente_telefone}]: ${msgWhatsApp}`);

        res.json({ mensagem: 'Remarcado com sucesso e notificação enviada ao WhatsApp do cliente!', msgWhatsApp });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao remarcar.' });
    }
});

app.delete('/agendamentos/:agendamento_id', async (req, res) => {
    const { agendamento_id } = req.params;
    try {
        await pool.query('DELETE FROM agendamentos WHERE id = $1', [agendamento_id]);
        res.json({ mensagem: 'Agendamento excluído com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao excluir agendamento.' });
    }
});

app.get('/espacos/:id/dashboards', async (req, res) => {
    const { id } = req.params;
    const { colaborador_id } = req.query; // Se passado, filtra ganhos apenas para a tela do funcionário

    try {
        let filtroColab = colaborador_id ? `AND a.colaborador_id = ${Number(colaborador_id)}` : '';

        // 1. Serviços que mais saem por categoria
        const servicosMaisSaem = await pool.query(`
            SELECT s.nome, s.categoria, COUNT(a.id) AS total_atendimentos
            FROM agendamentos a
            JOIN servicos s ON a.servico_id = s.id
            WHERE a.espaco_id = $1 ${filtroColab}
            GROUP BY s.nome, s.categoria
            ORDER BY total_atendimentos DESC
        `, [id]);

        // 2. Top Clientes
        const topClientes = await pool.query(`
            SELECT cliente_nome, cliente_telefone, COUNT(id) AS total_visitas, SUM(valor_cobrado) AS total_gasto
            FROM agendamentos a
            WHERE a.espaco_id = $1 ${filtroColab}
            GROUP BY cliente_nome, cliente_telefone
            ORDER BY total_visitas DESC
            LIMIT 10
        `, [id]);

        // 3. Receita Financeira (Pago vs Pendente/Local e por Colaborador)
        const receitaResumo = await pool.query(`
            SELECT 
                SUM(CASE WHEN status_pagamento = 'pago' THEN valor_cobrado ELSE 0 END) AS receita_confirmada,
                SUM(CASE WHEN status_pagamento = 'pendente' THEN valor_cobrado ELSE 0 END) AS receita_pendente,
                COUNT(id) AS total_agendamentos
            FROM agendamentos a
            WHERE a.espaco_id = $1 ${filtroColab}
        `, [id]);

        res.json({
            historico_categorias: servicosMaisSaem.rows,
            top_clientes: topClientes.rows,
            financeiro: receitaResumo.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao gerar métricas do dashboard.' });
    }
});

app.post('/agendamentos/:agendamento_id/pagar-pix', async (req, res) => {
    const { agendamento_id } = req.params;
    try {
        // Verifica se o espaço libera PIX direto na chave do colaborador
        const infoRes = await pool.query(`
            SELECT a.*, e.chave_pix_espaco, e.permitir_pix_colaborador, e.logo_url, e.nome AS espaco_nome,
                   col.chave_pix AS chave_pix_colaborador, col.nome AS colaborador_nome, s.preco
            FROM agendamentos a
            JOIN espacos e ON a.espaco_id = e.id
            JOIN servicos s ON a.servico_id = s.id
            LEFT JOIN colaboradores col ON a.colaborador_id = col.id
            WHERE a.id = $1
        `, [agendamento_id]);

        const dados = infoRes.rows[0];
        
        // Define para qual chave PIX o dinheiro vai
        const chaveDestino = (dados.permitir_pix_colaborador && dados.chave_pix_colaborador) 
            ? dados.chave_pix_colaborador 
            : dados.chave_pix_espaco;

        const payloadPix = `00020126360014BR.GOV.BCB.PIX0114${chaveDestino || 'CHAVE_PADRAO'}5204000053039865405${dados.preco}5802BR`;

        await pool.query(
            'UPDATE agendamentos SET forma_pagamento = $1, pix_copia_cola = $2, valor_cobrado = $3 WHERE id = $4',
            ['pix', payloadPix, dados.preco, agendamento_id]
        );

        res.json({
            chave_destinatario: chaveDestino,
            recebedor: (dados.permitir_pix_colaborador && dados.chave_pix_colaborador) ? dados.colaborador_nome : dados.espaco_nome,
            valor: dados.preco,
            pix_copia_cola: payloadPix
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao gerar código PIX.' });
    }
});

app.post('/agendamentos/:agendamento_id/confirmar-pagamento', async (req, res) => {
    const { agendamento_id } = req.params;
    try {
        const result = await pool.query(`
            UPDATE agendamentos SET status_pagamento = 'pago' WHERE id = $1 RETURNING *
        `, [agendamento_id]);

        const ag = result.rows[0];
        console.log(`[WHATSAPP COMPROVANTE]: Comprovante enviado para o cliente (${ag.cliente_telefone}) e para o dono!`);

        res.json({ mensagem: 'Status alterado para PAGO! Comprovantes enviados para cliente e proprietário.', agendamento: ag });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao confirmar pagamento.' });
    }
});