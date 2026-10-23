-- Migration 009: Add fee, request_hash, user_id to transfers and populate JPY clearing accounts
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS fee_amount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);

-- Ensure index for fast lookup of (user_id, idempotency_key)
CREATE INDEX IF NOT EXISTS idx_transfers_user_idempotency ON transfers(user_id, idempotency_key);

-- Add JPY system accounts for complete multi-currency support
INSERT INTO accounts (id, user_id, currency, balance, account_type)
VALUES
    ('00000000-0000-0000-0000-000000000007', NULL, 'JPY', 10000000000, 'SYSTEM_BANK_CASH'),
    ('00000000-0000-0000-0000-000000000008', NULL, 'JPY', 10000000000, 'SYSTEM_FX_CLEARING'),
    ('00000000-0000-0000-0000-000000000009', NULL, 'JPY', 0, 'SYSTEM_FEES_REVENUE'),
    ('00000000-0000-0000-0000-00000000000a', NULL, 'GBP', 10000000000, 'SYSTEM_BANK_CASH'),
    ('00000000-0000-0000-0000-00000000000b', NULL, 'GBP', 10000000000, 'SYSTEM_FX_CLEARING'),
    ('00000000-0000-0000-0000-00000000000c', NULL, 'GBP', 0, 'SYSTEM_FEES_REVENUE')
ON CONFLICT (id) DO NOTHING;
