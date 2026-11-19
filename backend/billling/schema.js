async function ensureSaasSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_accounts (
            id UUID PRIMARY KEY,
            space_id INTEGER,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            whatsapp_phone TEXT,
            whatsapp_opt_in_at TIMESTAMPTZ,
            password_hash TEXT NOT NULL,
            store_name TEXT NOT NULL,
            store_segment TEXT NOT NULL DEFAULT 'outros',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS space_id INTEGER;
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT;
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
        ALTER TABLE saas_accounts ADD COLUMN IF NOT EXISTS pix_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS saas_accounts_space_id_idx ON saas_accounts(space_id);
        DO $saas$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'saas_accounts_space_id_fkey'
                  AND conrelid = 'public.saas_accounts'::regclass
            ) THEN
                ALTER TABLE public.saas_accounts
                ADD CONSTRAINT saas_accounts_space_id_fkey
                FOREIGN KEY (space_id) REFERENCES public.espacos(id) ON DELETE RESTRICT;
            END IF;
        END
        $saas$;
        CREATE TABLE IF NOT EXISTS saas_sessions (
            token_hash CHAR(64) PRIMARY KEY,
            account_id UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_sessions_account_id_idx ON saas_sessions(account_id);
        CREATE TABLE IF NOT EXISTS saas_password_resets (
            token_hash CHAR(64) PRIMARY KEY,
            account_id UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_password_resets_account_id_idx ON saas_password_resets(account_id);
        CREATE TABLE IF NOT EXISTS saas_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            account_id UUID NOT NULL UNIQUE REFERENCES saas_accounts(id) ON DELETE CASCADE,
            provider TEXT NOT NULL DEFAULT 'mercadopago',
            provider_subscription_id TEXT UNIQUE,
            provider_status TEXT NOT NULL DEFAULT 'trialing',
            amount_brl NUMERIC(10, 2) NOT NULL,
            trial_days INTEGER NOT NULL DEFAULT 7,
            trial_started_at TIMESTAMPTZ,
            trial_ends_at TIMESTAMPTZ,
            next_payment_at TIMESTAMPTZ,
            checkout_url TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS saas_customers (
            id UUID PRIMARY KEY,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            phone TEXT NOT NULL,
            photo_url TEXT,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_customers ADD COLUMN IF NOT EXISTS photo_url TEXT;
        CREATE TABLE IF NOT EXISTS saas_employees (
            id UUID PRIMARY KEY,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            photo_url TEXT,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE saas_employees ADD COLUMN IF NOT EXISTS photo_url TEXT;
        CREATE TABLE IF NOT EXISTS saas_employee_spaces (
            employee_id UUID NOT NULL REFERENCES saas_employees(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            company_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0,
            linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (employee_id, space_id)
        );
        ALTER TABLE saas_employee_spaces
            ADD COLUMN IF NOT EXISTS company_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS saas_employee_codes (
            space_id INTEGER PRIMARY KEY REFERENCES espacos(id) ON DELETE CASCADE,
            created_by UUID NOT NULL REFERENCES saas_accounts(id) ON DELETE CASCADE,
            code_hash CHAR(64) NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS saas_service_professionals (
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            service_id TEXT NOT NULL,
            professional_type TEXT NOT NULL CHECK (professional_type IN ('owner', 'employee')),
            professional_id UUID NOT NULL,
            PRIMARY KEY (space_id, service_id, professional_type, professional_id)
        );
        CREATE INDEX IF NOT EXISTS saas_service_professionals_service_idx
            ON saas_service_professionals(space_id, service_id);
        CREATE TABLE IF NOT EXISTS configuracoes_horarios (
            espaco_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
            hora_inicio TIME NOT NULL,
            hora_fim TIME NOT NULL,
            ativo BOOLEAN NOT NULL DEFAULT FALSE,
            PRIMARY KEY (espaco_id, dia_semana)
        );
        CREATE TABLE IF NOT EXISTS saas_schedule_blocks (
            id UUID PRIMARY KEY,
            owner_space_id INTEGER REFERENCES espacos(id) ON DELETE CASCADE,
            employee_id UUID REFERENCES saas_employees(id) ON DELETE CASCADE,
            tipo_alvo TEXT NOT NULL CHECK (tipo_alvo IN ('dia', 'horario')),
            tipo_recorrencia TEXT NOT NULL CHECK (tipo_recorrencia IN ('especifico', 'semana_recorrente', 'diario_recorrente')),
            valor TEXT NOT NULL,
            hora_inicio TEXT,
            hora_fim TEXT,
            motivo TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((owner_space_id IS NOT NULL AND employee_id IS NULL)
                OR (owner_space_id IS NULL AND employee_id IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS saas_schedule_blocks_owner_idx
            ON saas_schedule_blocks(owner_space_id);
        CREATE INDEX IF NOT EXISTS saas_schedule_blocks_employee_idx
            ON saas_schedule_blocks(employee_id);
        CREATE TABLE IF NOT EXISTS saas_portal_sessions (
            token_hash CHAR(64) PRIMARY KEY,
            user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'employee')),
            user_id UUID NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS saas_portal_sessions_user_idx
            ON saas_portal_sessions(user_type, user_id);
        CREATE TABLE IF NOT EXISTS saas_customer_favorites (
            customer_id UUID NOT NULL REFERENCES saas_customers(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (customer_id, space_id)
        );
        CREATE TABLE IF NOT EXISTS saas_customer_recent_spaces (
            customer_id UUID NOT NULL REFERENCES saas_customers(id) ON DELETE CASCADE,
            space_id INTEGER NOT NULL REFERENCES espacos(id) ON DELETE CASCADE,
            last_visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (customer_id, space_id)
        );
        ALTER TABLE agendamentos
            ADD COLUMN IF NOT EXISTS saas_cliente_id UUID REFERENCES saas_customers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS saas_professional_type TEXT,
            ADD COLUMN IF NOT EXISTS saas_professional_id UUID,
            ADD COLUMN IF NOT EXISTS forma_pagamento TEXT,
            ADD COLUMN IF NOT EXISTS valor_servico NUMERIC(10, 2);
        DO $saas$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'agendamentos'
                  AND column_name = 'cliente_id'
                  AND data_type = 'uuid'
            ) THEN
                EXECUTE '
                    UPDATE agendamentos a
                    SET saas_cliente_id = a.cliente_id
                    FROM saas_customers c
                    WHERE c.id = a.cliente_id AND a.saas_cliente_id IS NULL
                ';
            END IF;
        END
        $saas$;
    `);
}

function createSchemaEnsure(pool) {
    let schemaPromise;
    return () => {
        if (!schemaPromise) {
            schemaPromise = ensureSaasSchema(pool).catch((error) => {
                schemaPromise = undefined;
                throw error;
            });
        }
        return schemaPromise;
    };
}

function isTimeoutError(error) {
    return ['57014', '55P03', 'ETIMEDOUT'].includes(error?.code)
        || /timeout/i.test(error?.message || '');
}

module.exports = {
    createSchemaEnsure,
    ensureSaasSchema,
    isTimeoutError
};