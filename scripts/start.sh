#!/bin/sh
set -e

echo "Running database migrations..."
node dist/scripts/migrate.js
echo "Migrations complete. Starting server..."
exec node dist/server.js
