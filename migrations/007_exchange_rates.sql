CREATE TABLE IF NOT EXISTS exchange_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    base_currency VARCHAR(3) NOT NULL,
    target_currency VARCHAR(3) NOT NULL,
    rate NUMERIC(18, 6) NOT NULL CHECK (rate > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_currency_pair UNIQUE (base_currency, target_currency)
);

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS destination_amount BIGINT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18, 6) DEFAULT 1.0;

-- Populate default FX rates
INSERT INTO exchange_rates (base_currency, target_currency, rate)
VALUES
    ('USD', 'EUR', 0.920000),
    ('EUR', 'USD', 1.086957),
    ('USD', 'GBP', 0.780000),
    ('GBP', 'USD', 1.282051),
    ('EUR', 'GBP', 0.847826),
    ('GBP', 'EUR', 1.179487),
    ('USD', 'JPY', 150.000000),
    ('JPY', 'USD', 0.006667)
ON CONFLICT (base_currency, target_currency) DO UPDATE 
SET rate = EXCLUDED.rate, updated_at = NOW();
