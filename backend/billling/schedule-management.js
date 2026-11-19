const crypto = require('crypto');
const { isValidScheduleBlock } = require('../schedule-utils');
const { getUtcWeekday } = require('../date-utils');

function scheduleBlockFromRow(row) {
    return {
        id: row.id,
        tipoAlvo: row.tipo_alvo,
        tipoRecorrencia: row.tipo_recorrencia,
        valor: row.valor,
        horaInicio: row.hora_inicio,
        horaFim: row.hora_fim,
        motivo: row.motivo,
        spaceId: row.owner_space_id,
        storeName: row.store_name || null,
        scope: row.owner_space_id ? 'store' : 'employee'
    };
}

function createScheduleManagementService({ pool, ensureSchema, requireOwnedSpace, requirePortalUser }) {
    async function saveScheduleBlock({ id, spaceId = null, employeeId = null, block }) {
        await pool.query(`
            INSERT INTO saas_schedule_blocks
                (id, owner_space_id, employee_id, tipo_alvo, tipo_recorrencia, valor, hora_inicio, hora_fim, motivo)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
                tipo_alvo = EXCLUDED.tipo_alvo,
                tipo_recorrencia = EXCLUDED.tipo_recorrencia,
                valor = EXCLUDED.valor,
                hora_inicio = EXCLUDED.hora_inicio,
                hora_fim = EXCLUDED.hora_fim,
                motivo = EXCLUDED.motivo
            WHERE saas_schedule_blocks.owner_space_id IS NOT DISTINCT FROM EXCLUDED.owner_space_id
              AND saas_schedule_blocks.employee_id IS NOT DISTINCT FROM EXCLUDED.employee_id
        `, [
            id,
            spaceId,
            employeeId,
            block.tipoAlvo,
            block.tipoRecorrencia,
            String(block.valor),
            block.horaInicio || null,
            block.horaFim || null,
            block.motivo.trim()
        ]);
    }

    async function getScheduleBlocksForSpace(spaceId, employeeId = null, executor = pool) {
        await ensureSchema();
        const result = await executor.query(`
            SELECT b.id, b.owner_space_id, b.employee_id, b.tipo_alvo, b.tipo_recorrencia,
                   b.valor, b.hora_inicio, b.hora_fim, b.motivo, e.nome AS store_name
            FROM saas_schedule_blocks b
            LEFT JOIN espacos e ON e.id = b.owner_space_id
            WHERE b.owner_space_id = $1 OR ($2::uuid IS NOT NULL AND b.employee_id = $2::uuid)
            ORDER BY b.created_at, b.id
        `, [spaceId, employeeId]);
        return result.rows.map(scheduleBlockFromRow);
    }

    function registerScheduleRoutes(app) {
        app.get('/api/saas/spaces/:id/schedule', requireOwnedSpace(async (req, res) => {
            const [hoursResult, blocksResult] = await Promise.all([
                pool.query(`
                    SELECT dia_semana, hora_inicio, hora_fim, ativo
                    FROM configuracoes_horarios
                    WHERE espaco_id = $1
                    ORDER BY dia_semana
                `, [req.params.id]),
                pool.query(`
                    SELECT id, tipo_alvo, tipo_recorrencia, valor, hora_inicio, hora_fim, motivo
                    FROM saas_schedule_blocks
                    WHERE owner_space_id = $1
                    ORDER BY created_at, id
                `, [req.params.id])
            ]);
            return res.json({
                hours: hoursResult.rows,
                blocks: blocksResult.rows.map(scheduleBlockFromRow)
            });
        }));

        if (typeof app.put === 'function') {
            app.put('/api/saas/spaces/:id/schedule/hours', requireOwnedSpace(async (req, res) => {
                const { hours } = req.body || {};
                const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
                if (!Array.isArray(hours) || hours.length !== 7
                    || hours.some((day, index) => !day || Number(day.dia_semana) !== index
                        || typeof day.ativo !== 'boolean'
                        || (day.ativo && (!timePattern.test(day.hora_inicio || '')
                            || !timePattern.test(day.hora_fim || '')
                            || day.hora_inicio >= day.hora_fim)))) {
                    return res.status(400).json({ error: 'Informe horários válidos para os sete dias da semana.' });
                }

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM configuracoes_horarios WHERE espaco_id = $1', [req.params.id]);
                    for (const day of hours) {
                        await client.query(`
                            INSERT INTO configuracoes_horarios (espaco_id, dia_semana, hora_inicio, hora_fim, ativo)
                            VALUES ($1, $2, $3, $4, $5)
                        `, [
                            req.params.id,
                            day.dia_semana,
                            day.ativo ? day.hora_inicio : '00:00',
                            day.ativo ? day.hora_fim : '00:00',
                            day.ativo
                        ]);
                    }
                    await client.query('COMMIT');
                    return res.json({ message: 'Expediente salvo.' });
                } catch (error) {
                    await client.query('ROLLBACK').catch((rollbackError) => console.error('Schedule hours rollback failed:', rollbackError));
                    console.error('Store schedule hours update failed:', error);
                    return res.status(500).json({ error: 'Não foi possível salvar o expediente.' });
                } finally {
                    client.release();
                }
            }));
        }

        app.post('/api/saas/spaces/:id/schedule/blocks', requireOwnedSpace(async (req, res) => {
            const block = req.body || {};
            if (!isValidScheduleBlock(block)) {
                return res.status(400).json({ error: 'Informe um bloqueio válido.' });
            }
            try {
                const id = crypto.randomUUID();
                await saveScheduleBlock({ id, spaceId: req.params.id, block });
                return res.status(201).json({ block: { ...block, id, scope: 'store', spaceId: Number(req.params.id) } });
            } catch (error) {
                console.error('Store schedule block creation failed:', error);
                return res.status(500).json({ error: 'Não foi possível salvar o bloqueio.' });
            }
        }));

        app.patch('/api/saas/spaces/:id/schedule/blocks/:blockId', requireOwnedSpace(async (req, res) => {
            const block = req.body || {};
            if (!/^[\da-f-]{36}$/i.test(req.params.blockId) || !isValidScheduleBlock(block)) {
                return res.status(400).json({ error: 'Informe um bloqueio válido.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_schedule_blocks
                    SET tipo_alvo = $1, tipo_recorrencia = $2, valor = $3, hora_inicio = $4, hora_fim = $5, motivo = $6
                    WHERE id = $7 AND owner_space_id = $8
                    RETURNING id
                `, [
                    block.tipoAlvo, block.tipoRecorrencia, String(block.valor),
                    block.horaInicio || null, block.horaFim || null, block.motivo.trim(),
                    req.params.blockId, req.params.id
                ]);
                if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio não encontrado.' });
                return res.json({ block: { ...block, id: req.params.blockId, scope: 'store', spaceId: Number(req.params.id) } });
            } catch (error) {
                console.error('Store schedule block update failed:', error);
                return res.status(500).json({ error: 'Não foi possível atualizar o bloqueio.' });
            }
        }));

        app.delete('/api/saas/spaces/:id/schedule/blocks/:blockId', requireOwnedSpace(async (req, res) => {
            try {
                const result = await pool.query(
                    'DELETE FROM saas_schedule_blocks WHERE id = $1 AND owner_space_id = $2 RETURNING id',
                    [req.params.blockId, req.params.id]
                );
                if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio não encontrado.' });
                return res.status(204).end();
            } catch (error) {
                console.error('Store schedule block removal failed:', error);
                return res.status(500).json({ error: 'Não foi possível remover o bloqueio.' });
            }
        }));

        app.get('/api/saas/spaces/:id/appointments', requireOwnedSpace(async (req, res) => {
            const { from, to } = req.query || {};
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')
                || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')
                || getUtcWeekday(from) === null
                || getUtcWeekday(to) === null
                || from >= to) {
                return res.status(400).json({ error: 'Informe um período válido para consultar a agenda.' });
            }
            try {
                const result = await pool.query(`
                    SELECT a.id, a.servico_id, a.saas_professional_id, a.saas_professional_type,
                           a.data_hora_inicio::date::text AS data,
                           to_char(a.data_hora_inicio, 'HH24:MI') AS hora,
                           a.cliente_nome, a.cliente_telefone, a.status, a.forma_pagamento,
                           s.nome AS servico_nome, COALESCE(a.valor_servico, s.preco, 0) AS valor,
                           COALESCE(employee.full_name, owner.full_name, 'Profissional') AS profissional_nome
                    FROM agendamentos a
                    LEFT JOIN servicos s ON s.id = a.servico_id
                    LEFT JOIN saas_employees employee
                        ON a.saas_professional_type = 'employee'
                       AND employee.id = a.saas_professional_id
                    LEFT JOIN saas_accounts owner
                        ON a.saas_professional_type = 'owner'
                       AND owner.id = a.saas_professional_id
                    WHERE a.espaco_id = $1
                      AND a.data_hora_inicio >= $2::date
                      AND a.data_hora_inicio < $3::date
                      AND a.status NOT IN ('cancelado', 'cancelada', 'concluido', 'concluído')
                    ORDER BY a.data_hora_inicio, a.id
                `, [req.params.id, from, to]);
                return res.json({
                    appointments: result.rows.map((appointment) => ({
                        ...appointment,
                        valor: Number(appointment.valor) || 0,
                        status: appointment.status === 'pago' ? 'pago' : 'agendado'
                    }))
                });
            } catch (error) {
                console.error('Owner appointment schedule retrieval failed:', error);
                return res.status(500).json({ error: 'Não foi possível carregar os agendamentos da loja.' });
            }
        }));

        app.get('/api/employee/schedule', requirePortalUser('employee', async (req, res) => {
            const spacesResult = await pool.query(`
                SELECT e.id AS space_id, e.nome AS store_name
                FROM saas_employee_spaces es
                JOIN espacos e ON e.id = es.space_id
                WHERE es.employee_id = $1
                ORDER BY e.nome
            `, [req.portalUserId]);
            const spaceIds = spacesResult.rows.map((space) => Number(space.space_id));
            if (!spaceIds.length) return res.json({ blocks: [], appointments: [] });
            const requestedSpace = req.query.space_id;
            if (requestedSpace && (!/^\d+$/.test(requestedSpace) || !spaceIds.includes(Number(requestedSpace)))) {
                return res.status(403).json({ error: 'Esta empresa não está vinculada à sua conta.' });
            }
            const filteredSpaceIds = requestedSpace ? [Number(requestedSpace)] : spaceIds;
            const [blocksResult, appointmentsResult] = await Promise.all([
                pool.query(`
                    SELECT b.id, b.owner_space_id, b.employee_id, b.tipo_alvo, b.tipo_recorrencia,
                           b.valor, b.hora_inicio, b.hora_fim, b.motivo, e.nome AS store_name
                    FROM saas_schedule_blocks b
                    LEFT JOIN espacos e ON e.id = b.owner_space_id
                    WHERE b.employee_id = $1 OR b.owner_space_id = ANY($2::integer[])
                    ORDER BY b.created_at, b.id
                `, [req.portalUserId, spaceIds]),
                pool.query(`
                    SELECT a.id, a.espaco_id AS space_id, e.nome AS store_name,
                           a.data_hora_inicio::date::text AS local_date,
                           to_char(a.data_hora_inicio, 'HH24:MI') AS local_time,
                           a.cliente_nome, a.cliente_telefone, a.status,
                           s.nome AS service_name, COALESCE(a.valor_servico, s.preco, 0) AS service_price
                    FROM agendamentos a
                    JOIN espacos e ON e.id = a.espaco_id
                    LEFT JOIN servicos s ON s.id = a.servico_id
                    WHERE a.espaco_id = ANY($1::integer[])
                      AND a.saas_professional_type = 'employee'
                      AND a.saas_professional_id = $2
                      AND a.status IN ('confirmado', 'agendado', 'pago')
                    ORDER BY a.data_hora_inicio
                `, [filteredSpaceIds, req.portalUserId])
            ]);
            return res.json({
                blocks: blocksResult.rows.map(scheduleBlockFromRow),
                appointments: appointmentsResult.rows.map((appointment) => ({
                    id: appointment.id,
                    space_id: Number(appointment.space_id),
                    store_name: appointment.store_name,
                    data: appointment.local_date,
                    hora: appointment.local_time,
                    cliente: appointment.cliente_nome,
                    telefone: appointment.cliente_telefone,
                    status: appointment.status === 'pago' ? 'pago' : 'agendado',
                    servico: appointment.service_name || 'Serviço',
                    valor: Number(appointment.service_price) || 0
                }))
            });
        }));

        app.post('/api/employee/schedule/blocks', requirePortalUser('employee', async (req, res) => {
            const block = req.body || {};
            if (!isValidScheduleBlock(block)) return res.status(400).json({ error: 'Informe um bloqueio válido.' });
            try {
                const id = crypto.randomUUID();
                await saveScheduleBlock({ id, employeeId: req.portalUserId, block });
                return res.status(201).json({ block: { ...block, id, scope: 'employee' } });
            } catch (error) {
                console.error('Employee schedule block creation failed:', error);
                return res.status(500).json({ error: 'Não foi possível salvar seu bloqueio.' });
            }
        }));

        app.patch('/api/employee/schedule/blocks/:blockId', requirePortalUser('employee', async (req, res) => {
            const block = req.body || {};
            if (!/^[\da-f-]{36}$/i.test(req.params.blockId) || !isValidScheduleBlock(block)) {
                return res.status(400).json({ error: 'Informe um bloqueio válido.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_schedule_blocks
                    SET tipo_alvo = $1, tipo_recorrencia = $2, valor = $3, hora_inicio = $4, hora_fim = $5, motivo = $6
                    WHERE id = $7 AND employee_id = $8
                    RETURNING id
                `, [
                    block.tipoAlvo, block.tipoRecorrencia, String(block.valor),
                    block.horaInicio || null, block.horaFim || null, block.motivo.trim(),
                    req.params.blockId, req.portalUserId
                ]);
                if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio pessoal não encontrado.' });
                return res.json({ block: { ...block, id: req.params.blockId, scope: 'employee' } });
            } catch (error) {
                console.error('Employee schedule block update failed:', error);
                return res.status(500).json({ error: 'Não foi possível atualizar seu bloqueio.' });
            }
        }));

        app.delete('/api/employee/schedule/blocks/:blockId', requirePortalUser('employee', async (req, res) => {
            try {
                const result = await pool.query(
                    'DELETE FROM saas_schedule_blocks WHERE id = $1 AND employee_id = $2 RETURNING id',
                    [req.params.blockId, req.portalUserId]
                );
                if (!result.rows[0]) return res.status(404).json({ error: 'Bloqueio pessoal não encontrado.' });
                return res.status(204).end();
            } catch (error) {
                console.error('Employee schedule block removal failed:', error);
                return res.status(500).json({ error: 'Não foi possível remover seu bloqueio.' });
            }
        }));
    }

    return {
        getScheduleBlocksForSpace,
        registerScheduleRoutes,
        saveScheduleBlock
    };
}

module.exports = {
    createScheduleManagementService,
    scheduleBlockFromRow
};