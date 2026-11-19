const crypto = require('crypto');
const { effectiveSubscription } = require('./subscription-engine');
const {
    isValidEmail,
    isValidOptionalImageUrl,
    normalizeWhatsAppPhone
} = require('./auth');

function createSpaceCatalogService({ pool, ensureSchema, isTimeoutError, requireAccount, requireOwnedSpace, requirePortalUser }) {
    async function getPublicPaymentSettings(spaceId) {
        await ensureSchema();
        const result = await pool.query(
            'SELECT pix_key FROM saas_accounts WHERE space_id = $1',
            [spaceId]
        );
        return { pix_key: result.rows[0]?.pix_key || '' };
    }

    async function readServicesForSpace(spaceId) {
        const [servicesResult, professionalsResult] = await Promise.all([
            pool.query(`
                SELECT id, nome, categoria, duracao_minutos, preco
                FROM servicos
                WHERE espaco_id = $1
                ORDER BY nome
            `, [spaceId]),
            pool.query(`
                SELECT sp.service_id, sp.professional_id, sp.professional_type,
                       CASE
                           WHEN sp.professional_type = 'employee' THEN e.full_name
                           ELSE a.full_name
                       END AS professional_name
                FROM saas_service_professionals sp
                LEFT JOIN saas_employees e
                    ON sp.professional_type = 'employee' AND e.id = sp.professional_id
                LEFT JOIN saas_accounts a
                    ON sp.professional_type = 'owner' AND a.id = sp.professional_id
                WHERE sp.space_id = $1
                ORDER BY professional_name
            `, [spaceId])
        ]);
        const professionalsByService = new Map();
        professionalsResult.rows.forEach((professional) => {
            const serviceId = String(professional.service_id);
            if (!professionalsByService.has(serviceId)) professionalsByService.set(serviceId, []);
            professionalsByService.get(serviceId).push({
                id: professional.professional_id,
                type: professional.professional_type,
                nome: professional.professional_name
            });
        });
        return servicesResult.rows.map((service) => ({
            ...service,
            profissionais: professionalsByService.get(String(service.id)) || []
        }));
    }

    async function saveServiceProfessionals(client, spaceId, serviceId, professionalIds) {
        if (!Array.isArray(professionalIds) || professionalIds.length > 100
            || professionalIds.some((id) => typeof id !== 'string'
                || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))) {
            return { error: 'Selecione profissionais válidos para o serviço.' };
        }

        const uniqueIds = [...new Set(professionalIds.map((id) => id.toLowerCase()))];
        if (uniqueIds.length !== professionalIds.length) {
            return { error: 'Um profissional foi selecionado mais de uma vez.' };
        }
        const employeesResult = await client.query(`
            SELECT e.id
            FROM saas_employee_spaces es
            JOIN saas_employees e ON e.id = es.employee_id
            WHERE es.space_id = $1 AND e.id = ANY($2::uuid[])
        `, [spaceId, uniqueIds]);
        const employeeIds = new Set(employeesResult.rows.map((employee) => String(employee.id).toLowerCase()));
        const ownerResult = uniqueIds.length
            ? await client.query('SELECT id FROM saas_accounts WHERE space_id = $1 AND id = ANY($2::uuid[])', [spaceId, uniqueIds])
            : { rows: [] };
        const ownerIds = new Set(ownerResult.rows.map((owner) => String(owner.id).toLowerCase()));
        const validIds = new Set([...employeeIds, ...ownerIds]);
        if (uniqueIds.some((id) => !validIds.has(id))) {
            return { error: 'Um ou mais profissionais não pertencem a esta loja.' };
        }

        await client.query(
            'DELETE FROM saas_service_professionals WHERE space_id = $1 AND service_id = $2',
            [spaceId, String(serviceId)]
        );
        for (const id of uniqueIds) {
            const type = ownerIds.has(id) ? 'owner' : 'employee';
            await client.query(`
                INSERT INTO saas_service_professionals
                    (space_id, service_id, professional_type, professional_id)
                VALUES ($1, $2, $3, $4)
            `, [spaceId, String(serviceId), type, id]);
        }
        return null;
    }

    async function getPublicServicesForSpace(spaceId) {
        await ensureSchema();
        return readServicesForSpace(spaceId);
    }

    function registerSpaceAndPortalRoutes(app) {
        app.get('/api/saas/payment-settings', requireAccount(async (req, res) => {
            try {
                const result = await pool.query(
                    'SELECT pix_key FROM saas_accounts WHERE id = $1',
                    [req.saasAccount.id]
                );
                return res.json({ pix_key: result.rows[0]?.pix_key || '' });
            } catch (error) {
                console.error('Payment settings retrieval failed:', error);
                return res.status(500).json({ error: 'Não foi possível carregar a chave PIX.' });
            }
        }));

        app.patch('/api/saas/payment-settings', requireAccount(async (req, res) => {
            const pixKey = req.body?.pix_key;
            if (typeof pixKey !== 'string' || pixKey.trim().length > 200) {
                return res.status(400).json({ error: 'A chave PIX deve ter até 200 caracteres.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_accounts
                    SET pix_key = NULLIF($1, '')
                    WHERE id = $2
                    RETURNING pix_key
                `, [pixKey.trim(), req.saasAccount.id]);
                if (!result.rows[0]) return res.status(404).json({ error: 'Conta do estabelecimento não encontrada.' });
                return res.json({ pix_key: result.rows[0].pix_key || '' });
            } catch (error) {
                console.error('Payment settings update failed:', error);
                return res.status(500).json({ error: 'Não foi possível salvar a chave PIX.' });
            }
        }));

        app.post('/api/saas/employee-code', requireAccount(async (req, res) => {
            const account = req.saasAccount;
            if (!account.space_id) return res.status(403).json({ error: 'Sua conta não possui um estabelecimento vinculado.' });
            if (!effectiveSubscription(account).can_access) {
                return res.status(402).json({ error: 'Sua assinatura não está ativa.' });
            }

            try {
                const code = crypto.randomBytes(6).toString('hex').toUpperCase();
                const codeHash = crypto.createHash('sha256').update(code).digest('hex');
                await pool.query(`
                    INSERT INTO saas_employee_codes (space_id, created_by, code_hash, created_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (space_id) DO UPDATE SET
                        created_by = EXCLUDED.created_by,
                        code_hash = EXCLUDED.code_hash,
                        created_at = NOW()
                `, [account.space_id, account.id, codeHash]);
                return res.json({ code, message: 'Código criado. Ele substitui o código anterior desta loja.' });
            } catch (error) {
                console.error('Employee company-code creation failed:', error);
                return res.status(500).json({ error: 'Não foi possível gerar o código da empresa.' });
            }
        }));

        app.get('/api/saas/employees', requireAccount(async (req, res) => {
            try {
                const result = await pool.query(`
                    SELECT e.id, e.full_name, e.email, es.linked_at, es.company_percentage
                    FROM saas_employee_spaces es
                    JOIN saas_employees e ON e.id = es.employee_id
                    WHERE es.space_id = $1
                    ORDER BY e.full_name
                `, [req.saasAccount.space_id]);
                return res.json(result.rows);
            } catch (error) {
                console.error('Employee list retrieval failed:', error);
                return res.status(500).json({ error: 'Não foi possível carregar a equipe vinculada.' });
            }
        }));

        app.get('/api/saas/spaces/:id/services', requireOwnedSpace(async (req, res) => {
            try {
                return res.json(await readServicesForSpace(req.saasAccount.space_id));
            } catch (error) {
                console.error('Owner service list retrieval failed:', error);
                return res.status(500).json({ error: 'Não foi possível carregar os serviços da loja.' });
            }
        }));

        app.post('/api/saas/spaces/:id/services', requireOwnedSpace(async (req, res) => {
            const { nome, categoria, duracao_minutos: duration, preco, profissionais } = req.body || {};
            const price = Number(preco);
            const serviceDuration = Number(duration);
            if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 150
                || (categoria !== undefined && (typeof categoria !== 'string' || categoria.trim().length > 80))
                || !Number.isInteger(serviceDuration) || serviceDuration < 1 || serviceDuration > 1440
                || !Number.isFinite(price) || price < 0 || price > 1000000) {
                return res.status(400).json({ error: 'Informe nome, categoria, duração e preço válidos para o serviço.' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const inserted = await client.query(`
                    INSERT INTO servicos (espaco_id, nome, categoria, duracao_minutos, preco)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id
                `, [
                    req.saasAccount.space_id,
                    nome.trim(),
                    typeof categoria === 'string' && categoria.trim() ? categoria.trim() : 'Geral',
                    serviceDuration,
                    price
                ]);
                const serviceId = inserted.rows[0]?.id;
                if (serviceId === undefined) throw new Error('Service insert did not return an ID.');
                const assignmentError = await saveServiceProfessionals(
                    client, req.saasAccount.space_id, serviceId, profissionais || []
                );
                if (assignmentError) {
                    await client.query('ROLLBACK');
                    return res.status(400).json(assignmentError);
                }
                await client.query('COMMIT');
                return res.status(201).json({ message: 'Serviço cadastrado.', id: serviceId });
            } catch (error) {
                await client.query('ROLLBACK').catch((rollbackError) => {
                    console.error('Service creation rollback failed:', rollbackError);
                });
                console.error('Owner service creation failed:', error);
                return res.status(500).json({ error: 'Não foi possível cadastrar o serviço.' });
            } finally {
                client.release();
            }
        }));

        app.patch('/api/saas/spaces/:id/services/:serviceId', requireOwnedSpace(async (req, res) => {
            const { serviceId } = req.params;
            const { nome, categoria, duracao_minutos: duration, preco, profissionais } = req.body || {};
            const price = Number(preco);
            const serviceDuration = Number(duration);
            if (!/^\d+$/.test(serviceId || '')
                || typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 150
                || (categoria !== undefined && (typeof categoria !== 'string' || categoria.trim().length > 80))
                || !Number.isInteger(serviceDuration) || serviceDuration < 1 || serviceDuration > 1440
                || !Number.isFinite(price) || price < 0 || price > 1000000) {
                return res.status(400).json({ error: 'Informe nome, categoria, duração e preço válidos para o serviço.' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const updated = await client.query(`
                    UPDATE servicos
                    SET nome = $1, categoria = $2, duracao_minutos = $3, preco = $4
                    WHERE id = $5 AND espaco_id = $6
                    RETURNING id
                `, [
                    nome.trim(),
                    typeof categoria === 'string' && categoria.trim() ? categoria.trim() : 'Geral',
                    serviceDuration,
                    price,
                    serviceId,
                    req.saasAccount.space_id
                ]);
                if (!updated.rows[0]) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Serviço não encontrado nesta loja.' });
                }
                const assignmentError = await saveServiceProfessionals(
                    client, req.saasAccount.space_id, serviceId, profissionais || []
                );
                if (assignmentError) {
                    await client.query('ROLLBACK');
                    return res.status(400).json(assignmentError);
                }
                await client.query('COMMIT');
                return res.json({ message: 'Serviço atualizado.' });
            } catch (error) {
                await client.query('ROLLBACK').catch((rollbackError) => {
                    console.error('Service update rollback failed:', rollbackError);
                });
                console.error('Owner service update failed:', error);
                return res.status(500).json({ error: 'Não foi possível atualizar o serviço.' });
            } finally {
                client.release();
            }
        }));

        app.delete('/api/saas/spaces/:id/services/:serviceId', requireOwnedSpace(async (req, res) => {
            if (!/^\d+$/.test(req.params.serviceId || '')) {
                return res.status(400).json({ error: 'Serviço inválido.' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    'DELETE FROM saas_service_professionals WHERE space_id = $1 AND service_id = $2',
                    [req.saasAccount.space_id, req.params.serviceId]
                );
                const deleted = await client.query(
                    'DELETE FROM servicos WHERE id = $1 AND espaco_id = $2 RETURNING id',
                    [req.params.serviceId, req.saasAccount.space_id]
                );
                if (!deleted.rows[0]) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Serviço não encontrado nesta loja.' });
                }
                await client.query('COMMIT');
                return res.json({ message: 'Serviço excluído.' });
            } catch (error) {
                await client.query('ROLLBACK').catch((rollbackError) => {
                    console.error('Service deletion rollback failed:', rollbackError);
                });
                console.error('Owner service deletion failed:', error);
                return res.status(500).json({ error: 'Não foi possível excluir o serviço.' });
            } finally {
                client.release();
            }
        }));

        app.patch('/api/saas/employees/:employeeId/commission', requireAccount(async (req, res) => {
            const { employeeId } = req.params;
            const percentage = req.body?.company_percentage;
            if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(employeeId || '')) {
                return res.status(400).json({ error: 'Funcionário inválido.' });
            }
            if (typeof percentage !== 'number' || !Number.isFinite(percentage)
                || percentage < 0 || percentage > 100 || Math.round(percentage * 100) !== percentage * 100) {
                return res.status(400).json({ error: 'Informe um percentual entre 0 e 100, com até duas casas decimais.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_employee_spaces
                    SET company_percentage = $1
                    WHERE employee_id = $2 AND space_id = $3
                    RETURNING employee_id, space_id, company_percentage
                `, [percentage, employeeId, req.saasAccount.space_id]);
                if (!result.rows[0]) return res.status(404).json({ error: 'Funcionário não vinculado a esta loja.' });
                return res.json({ commission: result.rows[0] });
            } catch (error) {
                console.error('Employee commission update failed:', error);
                return res.status(500).json({ error: 'Não foi possível salvar o percentual do funcionário.' });
            }
        }));

        app.get('/api/customer/me', requirePortalUser('customer', async (req, res) => {
            try {
                const [customerResult, favoritesResult, appointmentsResult, recentVisitsResult] = await Promise.all([
                    pool.query(
                        'SELECT id, full_name, email, phone, photo_url FROM saas_customers WHERE id = $1',
                        [req.portalUserId]
                    ),
                    pool.query(`
                        SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                               COALESCE(e.nicho, 'outros') AS segmento, e.logo_url
                        FROM saas_customer_favorites f
                        JOIN espacos e ON e.id = f.space_id
                        WHERE f.customer_id = $1
                        ORDER BY f.created_at DESC
                    `, [req.portalUserId]),
                    pool.query(`
                        SELECT a.id, a.espaco_id AS space_id, e.nome AS store_name,
                               s.nome AS service_name, COALESCE(a.valor_servico, s.preco, 0) AS service_price,
                               a.forma_pagamento, a.data_hora_inicio, a.data_hora_fim, a.status
                        FROM agendamentos a
                        JOIN espacos e ON e.id = a.espaco_id
                        LEFT JOIN servicos s ON s.id = a.servico_id
                        WHERE a.saas_cliente_id = $1
                        ORDER BY a.data_hora_inicio DESC
                    `, [req.portalUserId]),
                    pool.query(`
                        SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                               r.last_visited_at
                        FROM saas_customer_recent_spaces r
                        JOIN espacos e ON e.id = r.space_id
                        WHERE r.customer_id = $1
                        ORDER BY r.last_visited_at DESC
                        LIMIT 12
                    `, [req.portalUserId])
                ]);
                if (!customerResult.rows[0]) return res.status(404).json({ error: 'Conta de cliente não encontrada.' });

                const appointments = appointmentsResult.rows;
                const upcoming = appointments.filter((appointment) =>
                    new Date(appointment.data_hora_inicio) >= new Date()
                    && !['cancelado', 'cancelada', 'concluido', 'concluído'].includes(String(appointment.status).toLowerCase())
                );
                const history = appointments.filter((appointment) => !upcoming.includes(appointment));
                return res.json({
                    customer: customerResult.rows[0],
                    favorites: favoritesResult.rows,
                    recent_visits: recentVisitsResult.rows,
                    upcoming: upcoming.map((appointment) => ({
                        ...appointment,
                        service_price: Number(appointment.service_price) || 0
                    })),
                    history: history.map((appointment) => ({
                        ...appointment,
                        service_price: Number(appointment.service_price) || 0
                    }))
                });
            } catch (error) {
                console.error('Customer portal data retrieval failed:', error);
                const timedOut = isTimeoutError(error);
                return res.status(timedOut ? 503 : 500).json({
                    error: timedOut
                        ? 'O banco de dados demorou para responder. Tente novamente em instantes.'
                        : 'Não foi possível carregar seus dados de cliente.'
                });
            }
        }));

        app.patch('/api/customer/profile', requirePortalUser('customer', async (req, res) => {
            const { nome, email, telefone, photo_url: photoUrl } = req.body || {};
            const phone = normalizeWhatsAppPhone(telefone);
            if (typeof nome !== 'string' || nome.trim().length < 2 || nome.trim().length > 120) {
                return res.status(400).json({ error: 'Informe seu nome completo.' });
            }
            if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
            if (!phone) return res.status(400).json({ error: 'Informe um telefone válido com código do país.' });
            if (!isValidOptionalImageUrl(photoUrl)) {
                return res.status(400).json({ error: 'Informe um link de foto HTTP ou HTTPS válido.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_customers
                    SET full_name = $1, email = $2, phone = $3,
                        photo_url = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE photo_url END
                    WHERE id = $6
                    RETURNING id, full_name, email, phone, photo_url
                `, [nome.trim(), email.trim().toLowerCase(), phone, photoUrl !== undefined, photoUrl || null, req.portalUserId]);
                return res.json({ customer: result.rows[0] });
            } catch (error) {
                if (error.code === '23505') {
                    return res.status(409).json({ error: 'Já existe uma conta de cliente com este e-mail.' });
                }
                console.error('Customer profile update failed:', error);
                return res.status(500).json({ error: 'Não foi possível atualizar seu perfil.' });
            }
        }));

        app.post('/api/customer/favorites', requirePortalUser('customer', async (req, res) => {
            const { space_id: spaceId } = req.body || {};
            if (!/^\d+$/.test(String(spaceId || '')) || Number(spaceId) < 1) {
                return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
            }
            try {
                const storeResult = await pool.query('SELECT id FROM espacos WHERE id = $1', [spaceId]);
                if (storeResult.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
                await pool.query(`
                    INSERT INTO saas_customer_favorites (customer_id, space_id)
                    VALUES ($1, $2)
                    ON CONFLICT (customer_id, space_id) DO NOTHING
                `, [req.portalUserId, spaceId]);
                return res.status(201).json({ message: 'Estabelecimento adicionado aos favoritos.' });
            } catch (error) {
                console.error('Customer favorite creation failed:', error);
                return res.status(500).json({ error: 'Não foi possível salvar o favorito.' });
            }
        }));

        app.delete('/api/customer/favorites/:spaceId', requirePortalUser('customer', async (req, res) => {
            if (!/^\d+$/.test(req.params.spaceId)) {
                return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
            }
            try {
                await pool.query(
                    'DELETE FROM saas_customer_favorites WHERE customer_id = $1 AND space_id = $2',
                    [req.portalUserId, req.params.spaceId]
                );
                return res.json({ message: 'Estabelecimento removido dos favoritos.' });
            } catch (error) {
                console.error('Customer favorite deletion failed:', error);
                return res.status(500).json({ error: 'Não foi possível remover o favorito.' });
            }
        }));

        app.post('/api/customer/recent-visits', requirePortalUser('customer', async (req, res) => {
            const { space_id: spaceId } = req.body || {};
            if (!/^\d+$/.test(String(spaceId || '')) || Number(spaceId) < 1) {
                return res.status(400).json({ error: 'Informe um estabelecimento válido.' });
            }
            try {
                const storeResult = await pool.query('SELECT id FROM espacos WHERE id = $1', [spaceId]);
                if (storeResult.rows.length === 0) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
                await pool.query(`
                    INSERT INTO saas_customer_recent_spaces (customer_id, space_id, last_visited_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (customer_id, space_id)
                    DO UPDATE SET last_visited_at = NOW()
                `, [req.portalUserId, spaceId]);
                return res.status(204).end();
            } catch (error) {
                console.error('Customer recent-store update failed:', error);
                return res.status(500).json({ error: 'Não foi possível registrar a visita.' });
            }
        }));

        app.get('/api/employee/me', requirePortalUser('employee', async (req, res) => {
            const [employeeResult, spacesResult] = await Promise.all([
                pool.query(
                    'SELECT id, full_name, email, photo_url FROM saas_employees WHERE id = $1',
                    [req.portalUserId]
                ),
                pool.query(`
                    SELECT e.id AS space_id, e.nome AS store_name, e.nicho,
                           es.company_percentage,
                           s.provider_status, s.trial_ends_at, s.next_payment_at
                    FROM saas_employee_spaces es
                    JOIN espacos e ON e.id = es.space_id
                    LEFT JOIN saas_accounts a ON a.space_id = es.space_id
                    LEFT JOIN saas_subscriptions s ON s.account_id = a.id
                    WHERE es.employee_id = $1
                    ORDER BY e.nome
                `, [req.portalUserId])
            ]);
            return res.json({
                employee: employeeResult.rows[0],
                spaces: spacesResult.rows.map((space) => ({
                    space_id: space.space_id,
                    store_name: space.store_name,
                    nicho: space.nicho,
                    company_percentage: Number(space.company_percentage) || 0,
                    can_access: effectiveSubscription(space).can_access
                }))
            });
        }));

        app.patch('/api/employee/profile', requirePortalUser('employee', async (req, res) => {
            const { photo_url: photoUrl } = req.body || {};
            if (!isValidOptionalImageUrl(photoUrl)) {
                return res.status(400).json({ error: 'Informe um link de foto HTTP ou HTTPS válido.' });
            }
            try {
                const result = await pool.query(`
                    UPDATE saas_employees
                    SET photo_url = NULLIF($1, '')
                    WHERE id = $2
                    RETURNING id, full_name, email, photo_url
                `, [photoUrl || '', req.portalUserId]);
                if (!result.rows[0]) return res.status(404).json({ error: 'Conta profissional não encontrada.' });
                return res.json({ employee: result.rows[0] });
            } catch (error) {
                console.error('Employee profile update failed:', error);
                return res.status(500).json({ error: 'Não foi possível atualizar sua foto de perfil.' });
            }
        }));

        app.post('/api/employee/join', requirePortalUser('employee', async (req, res) => {
            const { codigo_empresa: code } = req.body || {};
            if (typeof code !== 'string' || !/^[\da-f]{12}$/i.test(code.trim())) {
                return res.status(400).json({ error: 'Informe um código de empresa válido.' });
            }
            try {
                const codeHash = crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
                const companyResult = await pool.query(`
                    SELECT c.space_id, s.provider_status, s.trial_ends_at, s.next_payment_at
                    FROM saas_employee_codes c
                    JOIN saas_accounts a ON a.id = c.created_by
                    JOIN saas_subscriptions s ON s.account_id = a.id
                    WHERE c.code_hash = $1
                `, [codeHash]);
                const company = companyResult.rows[0];
                if (!company) return res.status(404).json({ error: 'Código da empresa inválido ou desativado.' });
                if (!effectiveSubscription(company).can_access) {
                    return res.status(402).json({ error: 'A assinatura desta empresa não está ativa.' });
                }
                const result = await pool.query(`
                    INSERT INTO saas_employee_spaces (employee_id, space_id)
                    VALUES ($1, $2)
                    ON CONFLICT (employee_id, space_id) DO NOTHING
                    RETURNING space_id
                `, [req.portalUserId, company.space_id]);
                if (result.rows.length === 0) {
                    return res.status(409).json({ error: 'Você já está vinculado a esta empresa.' });
                }
                return res.status(201).json({ message: 'Vínculo com a empresa criado.' });
            } catch (error) {
                console.error('Employee company join failed:', error);
                return res.status(500).json({ error: 'Não foi possível vincular sua conta à empresa.' });
            }
        }));
    }

    return {
        getPublicPaymentSettings,
        getPublicServicesForSpace,
        registerSpaceAndPortalRoutes
    };
}

module.exports = {
    createSpaceCatalogService
};