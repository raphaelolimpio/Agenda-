const { getUtcWeekday } = require('./date-utils');
const { isBlockedPeriod } = require('./schedule-utils');

async function createAtomicAppointment(pool, saasBilling, {
    spaceId,
    serviceId,
    data,
    horario,
    paymentMethod = 'local',
    timezoneOffset = 180,
    professionalId = '',
    professionalType = '',
    customer
}) {
    if (!customer) {
        const err = new Error('Entre na sua conta de cliente para confirmar o atendimento.');
        err.status = 401;
        throw err;
    }

    const [year, month, day] = data.split('-').map(Number);
    const [hour, minute] = horario.split(':').map(Number);
    const requestedDateTime = new Date(Date.UTC(year, month - 1, day, hour, minute));

    if (
        requestedDateTime.getUTCFullYear() !== year ||
        requestedDateTime.getUTCMonth() !== month - 1 ||
        requestedDateTime.getUTCDate() !== day
    ) {
        const err = new Error('Escolha uma data válida.');
        err.status = 400;
        throw err;
    }

    const startsAt = new Date(requestedDateTime.getTime() + timezoneOffset * 60_000);
    if (startsAt <= new Date()) {
        const err = new Error('Escolha uma data e horário futuros.');
        err.status = 400;
        throw err;
    }

    const startTimestamp = `${data} ${horario}:00`;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${spaceId}:${data}`]);
        if (professionalId && professionalType === 'employee') {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`employee:${professionalId}:${data}`]);
        }

        const serviceResult = await client.query(
            'SELECT id, duracao_minutos, preco FROM servicos WHERE id = $1 AND espaco_id = $2',
            [serviceId, spaceId]
        );
        if (serviceResult.rows.length === 0) {
            const err = new Error('Serviço não encontrado neste estabelecimento.');
            err.status = 404;
            throw err;
        }

        if (paymentMethod === 'pix') {
            const paymentSettings = await client.query(
                'SELECT pix_key FROM saas_accounts WHERE space_id = $1',
                [spaceId]
            );
            if (!paymentSettings.rows[0]?.pix_key) {
                const err = new Error('A loja ainda não configurou uma chave PIX. Escolha pagar no local.');
                err.status = 409;
                throw err;
            }
        }

        const professionalResult = await client.query(`
            SELECT professional_id AS id, professional_type AS type
            FROM saas_service_professionals
            WHERE space_id = $1 AND service_id = $2
        `, [spaceId, String(serviceId)]);

        const serviceProfessionals = professionalResult.rows;
        let professional = null;

        if (professionalId) {
            professional = serviceProfessionals.find(
                (item) => item.type === professionalType && item.id.toLowerCase() === professionalId.toLowerCase()
            );
            if (!professional) {
                const err = new Error('Este profissional não está vinculado ao serviço.');
                err.status = 400;
                throw err;
            }
        } else if (serviceProfessionals.length === 1) {
            professional = serviceProfessionals[0];
        } else if (serviceProfessionals.length > 1) {
            const err = new Error('Escolha o profissional que realizará este serviço.');
            err.status = 400;
            throw err;
        }

        const weekday = getUtcWeekday(data);
        const hoursResult = await client.query(`
            SELECT hora_inicio, hora_fim, ativo
            FROM configuracoes_horarios
            WHERE espaco_id = $1 AND dia_semana = $2
        `, [spaceId, weekday]);

        const hours = hoursResult.rows[0];
        if (!hours || !hours.ativo) {
            const err = new Error('O estabelecimento não atende neste dia.');
            err.status = 409;
            throw err;
        }

        const duration = Number(serviceResult.rows[0].duracao_minutos);
        const [startHour, startMinute] = horario.split(':').map(Number);
        const [closeHour, closeMinute] = String(hours.hora_fim).slice(0, 5).split(':').map(Number);
        const [openHour, openMinute] = String(hours.hora_inicio).slice(0, 5).split(':').map(Number);

        const startMinutes = startHour * 60 + startMinute;
        const closeMinutes = closeHour * 60 + closeMinute;
        const openMinutes = openHour * 60 + openMinute;
        const endMinutes = startMinutes + duration;

        if (
            !Number.isFinite(duration) ||
            duration < 1 ||
            startMinutes < openMinutes ||
            (startMinutes - openMinutes) % duration !== 0 ||
            endMinutes > closeMinutes
        ) {
            const err = new Error('O horário escolhido está fora do expediente.');
            err.status = 409;
            throw err;
        }

        const scheduleBlocks = await saasBilling.getScheduleBlocksForSpace(
            spaceId,
            professional?.type === 'employee' ? professional.id : null,
            client
        );

        if (isBlockedPeriod(scheduleBlocks, data, startMinutes, endMinutes)) {
            const err = new Error('Esse horário está bloqueado. Escolha outro horário.');
            err.status = 409;
            throw err;
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
        `, [spaceId, startTimestamp, duration, professional?.id || null, professional?.type || null]);

        if (conflictResult.rows[0].has_conflict) {
            const err = new Error('Esse horário acabou de ser reservado. Escolha outro horário.');
            err.status = 409;
            throw err;
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
            spaceId,
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
        return {
            appointment: {
                ...appointmentResult.rows[0],
                valor: Number(serviceResult.rows[0].preco) || 0,
                pagamento_status: 'pendente'
            }
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { createAtomicAppointment };