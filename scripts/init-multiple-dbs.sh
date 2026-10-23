#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE digital_wallet_test;
    GRANT ALL PRIVILEGES ON DATABASE digital_wallet_test TO $POSTGRES_USER;
EOSQL
