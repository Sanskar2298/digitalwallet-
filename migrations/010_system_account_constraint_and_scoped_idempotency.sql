-- Migration 010: Exempt system accounts from non-negative balance constraint and scope idempotency to user
-- 1. Modify accounts CHECK constraint so system clearing accounts can carry negative balances as platform FX inventory
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_balance_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_balance_check 
    CHECK (account_type != 'CUSTOMER_WALLET' OR balance >= 0);

-- 2. Scope idempotency key uniqueness to (user_id, idempotency_key)
-- Drop old global unique index on idempotency_key alone
DROP INDEX IF EXISTS idx_transfers_idempotency_key;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_idempotency_key_key;

-- Create composite unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_user_idempotency_key 
    ON transfers(COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key);
