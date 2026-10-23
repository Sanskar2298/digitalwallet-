DO $$ BEGIN
    CREATE TYPE transfer_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_account UUID REFERENCES accounts(id) ON DELETE RESTRICT,
    to_account UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    status transfer_status NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    response_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_idempotency_key ON transfers(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_transfers_from_account ON transfers(from_account);
CREATE INDEX IF NOT EXISTS idx_transfers_to_account ON transfers(to_account);
CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers(created_at);
