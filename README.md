# Digital Wallet & Double-Entry Ledger API

A production-grade, backend-only digital wallet and financial ledger service built with **Node.js**, **TypeScript**, **Fastify**, and **PostgreSQL** using raw `pg` for all transaction-critical execution.

Supports **multi-currency transfers** with real-time FX conversion, a **formal Chart of Accounts** (Asset, Liability, Revenue), and an **event-driven Transactional Outbox** for reliable downstream messaging.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Key Features](#key-features)
- [Transfer Transaction Pipeline](#transfer-transaction-pipeline)
- [Multi-Currency FX Transfer Flow](#multi-currency-fx-transfer-flow)
- [Chart of Accounts](#chart-of-accounts)
- [Transactional Outbox & Event-Driven Architecture](#transactional-outbox--event-driven-architecture)
- [Database Schema (8 Migrations)](#database-schema-8-migrations)
- [API Endpoints](#api-endpoints)
- [Design Decisions & Trade-Offs](#design-decisions--trade-offs)
- [Getting Started](#getting-started)
- [Running the Automated Test Suite](#running-the-automated-test-suite)
- [Scripts & Tooling](#scripts--tooling)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Next Steps / Roadmap](#next-steps--roadmap)

---

## Architecture Overview

The system strictly implements **double-entry bookkeeping principles**:
- Money is never created or destroyed arbitrarily. Every transfer creates exactly two balancing ledger entries: a negative debit (`-amount`) and a positive credit (`+amount`).
- The `ledger_entries` table is **append-only and immutable**, enforced by a database trigger preventing `UPDATE` and `DELETE` operations.
- Account balances are cached directly on `accounts.balance` for $O(1)$ read performance, guaranteed strictly consistent via database transactions and row-level locks.

```mermaid
flowchart TD
    Client(["Client / API Consumer"]) -->|HTTPS / JWT| Fastify["Fastify HTTP Server"]
    Fastify --> CentralizedErr["Centralized Error Handler"]
    Fastify --> RateLimiter["Rate Limiter"]
    Fastify --> Swagger["Swagger / OpenAPI (/docs)"]

    subgraph Core Modules
        Fastify --> AuthMod["Auth Module (JWT)"]
        Fastify --> AccMod["Accounts & Deposits"]
        Fastify --> TxMod["Transfers Module"]
        Fastify --> LedgerMod["Ledger & Transactions"]
    end

    subgraph Advanced Modules
        Fastify --> FxMod["FX / Exchange Rates"]
        Fastify --> OutboxMod["Transactional Outbox"]
    end

    subgraph PostgreSQL Database
        TxMod -->|Raw pg Pool| PG[("PostgreSQL 16")]
        FxMod --> PG
        OutboxMod --> PG
        PG --> UsersTable[("users")]
        PG --> AccountsTable[("accounts\nCHECK balance >= 0\naccount_type ENUM")]
        PG --> TransfersTable[("transfers\nUNIQUE idempotency_key\nexchange_rate, destination_amount")]
        PG --> LedgerTable[("ledger_entries\nInsert-Only Trigger")]
        PG --> ExchangeRatesTable[("exchange_rates\nUNIQUE currency pair")]
        PG --> OutboxTable[("outbox_events\nFOR UPDATE SKIP LOCKED")]
    end
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Double-Entry Bookkeeping** | Every transaction creates balanced debit + credit ledger entries. Ledger is append-only and immutable (database trigger enforced). |
| **Atomic Transfers** | Entire transfer logic executes within a single PostgreSQL `BEGIN...COMMIT` transaction with row-level locking. |
| **Idempotent Transfers** | `UNIQUE` idempotency key with response caching prevents duplicate money movements on network retries. |
| **Deadlock Prevention** | Accounts always locked in ascending UUID order to prevent cyclic waits under parallel bi-directional transfers. |
| **Multi-Currency FX** | Cross-currency transfers (`USD → EUR`, `GBP → JPY`, etc.) using real-time exchange rates with automatic conversion. |
| **Chart of Accounts** | Formal account types: `CUSTOMER_WALLET`, `SYSTEM_BANK_CASH`, `SYSTEM_FX_CLEARING`, `SYSTEM_FEES_REVENUE`. |
| **Transactional Outbox** | Domain events (`transfer.completed`, `transfer.fx_converted`, `deposit.completed`, `transfer.reversed`) emitted atomically inside the same DB transaction. Background worker dispatches events reliably. |
| **Transfer Reversals** | Append-only reversal pattern: never edits existing ledger entries, instead creates new offsetting entries. |
| **Cursor-Based Pagination** | Stable, performant pagination using composite `(created_at, id)` cursors instead of OFFSET/LIMIT. |
| **Financial Reconciliation** | Standalone script audits all accounts by comparing cached balances vs. `SUM(ledger_entries)`. |
| **Rate Limiting** | Per-endpoint rate limiting on auth and transfer routes to prevent abuse. |
| **OpenAPI / Swagger** | Auto-generated interactive API docs at `/docs`. |
| **JWT Authentication** | Stateless authentication with bcrypt password hashing. |
| **100-Transfer Concurrency Test** | Proves zero deadlocks, exact balance invariance, and $\Sigma\text{ledger} = 0$ under parallel load. |

---

## Transfer Transaction Pipeline

Every money transfer executes within an isolated PostgreSQL transaction adhering to strict deadlock prevention and concurrency safety:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as Fastify API
    participant FX as FX Service
    participant DB as PostgreSQL (Single Transaction)
    participant Outbox as Outbox Table

    Client->>API: POST /transfers (Idempotency-Key: "uuid")
    API->>DB: BEGIN
    API->>DB: SELECT response_payload FROM transfers WHERE idempotency_key = $key
    alt Idempotency Key Exists
        DB-->>API: Saved response payload
        API-->>Client: 200 OK (Cached Result)
    else First Time Request
        API->>DB: SELECT ... FROM accounts WHERE id IN (acc1, acc2) ORDER BY id ASC FOR UPDATE
        Note over DB: Locks acquired in deterministic order<br/>Prevents deadlocks under parallel transfers
        API->>API: Verify caller ownership & balance >= amount
        opt Cross-Currency Transfer
            API->>FX: getRate(fromCurrency, toCurrency)
            FX-->>API: exchangeRate, destinationAmount
        end
        API->>DB: INSERT INTO transfers (from, to, amount, destination_amount, exchange_rate, status, key)
        API->>DB: INSERT INTO ledger_entries (transfer_id, from_account, -sourceAmount)
        API->>DB: INSERT INTO ledger_entries (transfer_id, to_account, +destinationAmount)
        API->>DB: UPDATE accounts SET balance = balance - sourceAmount WHERE id = from
        API->>DB: UPDATE accounts SET balance = balance + destinationAmount WHERE id = to
        API->>Outbox: INSERT INTO outbox_events (transfer.completed / transfer.fx_converted)
        API->>DB: UPDATE transfers SET response_payload = $response
        API->>DB: COMMIT
        API-->>Client: 200 OK (Transfer Details, Balances, FX Info)
    end
```

---

## Multi-Currency FX Transfer Flow & True Double-Entry

Cross-currency transfers use **true double-entry balancing** via `SYSTEM_FX_CLEARING` accounts. In financial accounting, currency values cannot be summed directly across borders ($\text{USD} + \text{EUR} \neq 0$). Therefore, the engine executes **two balancing legs (4 immutable ledger entries total)**:

```mermaid
sequenceDiagram
    participant Alice as Alice (USD Wallet)
    participant ClearingUSD as SYSTEM_FX_CLEARING (USD)
    participant ClearingEUR as SYSTEM_FX_CLEARING (EUR)
    participant Bob as Bob (EUR Wallet)

    Note over Alice,ClearingUSD: USD Leg (Balances to 0)
    Alice->>ClearingUSD: -$50.00 USD (Alice Debit)
    ClearingUSD-->>Alice: +$50.00 USD (USD Clearing Credit)

    Note over ClearingEUR,Bob: EUR Leg (Balances to 0)
    ClearingEUR->>Bob: -€46.00 EUR (EUR Clearing Debit)
    Bob-->>ClearingEUR: +€46.00 EUR (Bob Credit)
```

**Properties:**
1. **Per-Currency Conservation ($\sum = 0$):** Every individual currency balances to exactly zero inside the single ACID transaction.
2. **Platform Inventory Tracking:** The clearing accounts continuously reflect the platform's net FX exposure/inventory.
3. **ISO 4217 Minor-Unit Exponent Normalization:** Currencies have variable decimal exponents ($10^{\text{target\_exp} - \text{base\_exp}}$):
   - **USD, EUR, GBP:** 2 decimal places ($1 = 100\text{ cents}$)
   - **JPY, KRW:** 0 decimal places ($1 = 1\text{ yen}$)
   - **BHD, KWD:** 3 decimal places ($1 = 1000\text{ fils}$)
   - *Example:* A $50.00 USD (5,000 cents) transfer to JPY at rate $150.0$ converts to $5000 \times 150 \times 10^{0 - 2} = 7,500\text{ JPY}$ (¥7,500), avoiding 100x over-crediting.

---

## Chart of Accounts

The engine uses a formal **Chart of Accounts** with typed accounts:

| Account Type | Purpose | Has Owner? |
|---|---|---|
| `CUSTOMER_WALLET` | End-user wallet (default) | Yes (`user_id`) |
| `SYSTEM_BANK_CASH` | Cash reserves backing customer deposits (Asset) | No (System) |
| `SYSTEM_FX_CLEARING` | Balanced clearing accounts for multi-currency settlements | No (System) |
| `SYSTEM_FEES_REVENUE` | Revenue from processing fees and spreads | No (System) |

**Pre-provisioned system accounts:**
- `USD`, `EUR`, `GBP`, `JPY` Bank Cash accounts
- `USD`, `EUR`, `GBP`, `JPY` FX Clearing accounts
- `USD`, `EUR`, `GBP`, `JPY` Fee Revenue accounts

---

## Transactional Outbox & Background Poller

The **Transactional Outbox Pattern** guarantees reliable, atomic event emission:

```mermaid
flowchart LR
    TX["Database Transaction"] --> Transfer["INSERT transfer"]
    TX --> Ledger["INSERT 4x ledger_entries"]
    TX --> Balance["UPDATE balances"]
    TX --> Outbox["INSERT outbox_events\n(same transaction)"]
    TX --> Commit["COMMIT ✅"]

    Commit --> Poller["Autonomous Background Poller\n(3s interval worker)"]
    Poller -->|"FOR UPDATE SKIP LOCKED"| Dispatch["Dispatch to\nKafka / Webhooks"]
    Dispatch --> Published["Mark PUBLISHED\nwith timestamp"]
```

**Security & Architecture:**
- **Automated Background Poller:** Runs continuously inside the process (configurable via `OUTBOX_POLL_INTERVAL_MS`), using `FOR UPDATE SKIP LOCKED` for concurrent cluster safety.
- **Admin Authentication:** The HTTP event audit endpoints (`GET /outbox/events` and `POST /outbox/process`) are locked behind `X-Admin-Key` verification to protect sensitive financial payloads.

---

## Database Schema (9 Migrations)

| # | Migration | Description |
|---|---|---|
| 001 | `create_users` | Users table with UUID PK, unique email, bcrypt hash |
| 002 | `create_accounts` | Accounts with `BIGINT balance`, `CHECK >= 0`, user FK |
| 003 | `create_transfers` | Transfers with `UNIQUE idempotency_key`, `response_payload JSONB`, status enum |
| 004 | `create_ledger_entries` | Insert-only ledger entries with transfer + account FKs |
| 005 | `prevent_ledger_tampering` | PostgreSQL trigger blocking `UPDATE`/`DELETE` on ledger |
| 006 | `chart_of_accounts` | `account_type` enum, pre-provisioned system accounts |
| 007 | `exchange_rates` | FX rates table, `destination_amount`/`exchange_rate` columns, 8 seeded pairs |
| 008 | `outbox_events` | Outbox table with status tracking, retry count, indexed on `(status, created_at)` |
| 009 | `harden_transfers_and_system_accounts` | Added `user_id`, `request_hash`, `fee_amount`, plus JPY & GBP system accounts |

---

## API Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Register a new user | No (Rate-limited) |
| `POST` | `/auth/login` | Authenticate and obtain JWT token | No (Rate-limited) |
| `POST` | `/accounts` | Create a new wallet account | Yes |
| `GET` | `/accounts/:id` | Fetch account balance and info | Yes (Owner) |
| `POST` | `/accounts/:id/deposit` | Atomically deposit funds | Yes (Owner) |
| `POST` | `/transfers` | Transfer money with double-entry ledger | Yes (Owner, Rate-limited) |
| `POST` | `/transfers/:id/reverse` | Reverse a completed transfer | Yes (Original Sender / Admin) |
| `GET` | `/accounts/:id/transactions` | Cursor-paginated ledger entries with date/type filters | Yes (Owner) |
| `GET` | `/fx/rates` | List all available FX exchange rates | No |
| `GET` | `/outbox/events` | Query outbox audit log (sensitive payloads) | **Admin** (`X-Admin-Key`) |
| `POST` | `/outbox/process` | Trigger manual processing of pending outbox events | **Admin** (`X-Admin-Key`) |
| `GET` | `/health` | Health check for API and PostgreSQL | No |
| `GET` | `/docs` | Interactive Swagger / OpenAPI UI | No |

---

## Stripe-Style Idempotency Engine

The idempotency layer handles real-world distributed edge cases:
1. **Request Fingerprinting (SHA-256):** Every transfer computes `SHA256(userId + fromAccountId + toAccountId + amount)`.
2. **Payload Mismatch Protection (HTTP 422):** If a client retries with an identical `Idempotency-Key` but alters the payload (e.g. changing amount from $10 to $500), the request is rejected with `422 Unprocessable Entity`.
3. **Database Race Handling (23505 Unique Violation):** If two identical requests race past the initial check concurrently, Postgres blocks one at the database unique index. The losing transaction catches error `23505`, waits for the winner's commit, and returns the committed response without a 500.

---

## Design Decisions & Trade-Offs

### 1. Raw `pg` vs ORM (Prisma / TypeORM)
* **Decision**: Raw `pg` for all transaction-critical code.
* **Rationale**: Financial systems require explicit control over `SELECT ... FOR UPDATE`, transaction isolation levels, deterministic lock ordering, and connection checkout. ORMs introduce uncontrolled implicit queries and non-deterministic join locking.

### 2. Monetary Precision: `BIGINT` Minor Units (Cents)
* **Decision**: All balances and amounts stored as 64-bit integer cents with `CHECK (balance >= 0)` and `CHECK (amount > 0)`.
* **Rationale**: Floating-point suffers from binary rounding (`0.1 + 0.2 ≠ 0.3`). Integer cents provide exact arithmetic and payment gateway compatibility (Stripe, Adyen).

### 3. Deadlock Prevention via Deterministic Lock Ordering
* **Decision**: Both accounts locked using `SELECT ... FOR UPDATE ... ORDER BY id ASC`.
* **Rationale**: Bi-directional transfers ($A → B$ and $B → A$) concurrently would create cyclic waits. Deterministic ordering by UUID guarantees an invariant locking hierarchy.

### 4. Database-Enforced Ledger Immutability
* **Decision**: PostgreSQL trigger `trg_prevent_ledger_update_delete` raises an exception on any `UPDATE` or `DELETE`.
* **Rationale**: No software bug or rogue query can tamper with the financial audit trail. Reversals create new offsetting entries.

### 5. Cached Balances with Reconciliation Proof
* **Decision**: Balances cached on `accounts.balance` instead of computing `SUM(ledger_entries.amount)` per request.
* **Rationale**: On-the-fly summing is $O(N)$ over millions of rows. Cached balance provides $O(1)$ reads. Correctness proven by the reconciliation job.

### 6. Idempotency Response Caching (In-DB, No Redis)
* **Decision**: `UNIQUE` constraint on `idempotency_key` with `response_payload JSONB` stored on the transfer.
* **Rationale**: Network retries receive the exact original response without duplicating money. No external cache dependency required.

### 7. Cursor-Based Pagination
* **Decision**: Composite `(created_at, id)` cursor instead of `OFFSET/LIMIT`.
* **Rationale**: `OFFSET` degrades to $O(N)$ on deep pages and misses/duplicates rows on concurrent inserts. Cursors use indexed lookups.

### 8. Transactional Outbox (No Dual-Write Risk)
* **Decision**: Outbox events inserted in the **same** database transaction as the financial mutation.
* **Rationale**: Avoids the dual-write problem where a transfer commits but the event publish fails (or vice versa). The outbox worker can safely retry from `PENDING` events.

### 9. FX Rate Lookup with Inverse Fallback
* **Decision**: If no direct rate exists for `USD→GBP`, the system checks `GBP→USD` and computes the inverse.
* **Rationale**: Halves the number of required rate entries. Rates are stored with `NUMERIC(18,6)` precision.

---

## Getting Started

### Prerequisites
- **Node.js** >= 20
- **PostgreSQL** >= 15 (or Docker)
- **Docker** (optional, for containerized Postgres)

### 1. Environment Setup
```bash
cp .env.example .env
npm install
```

### 2. Start PostgreSQL via Docker Compose
```bash
docker compose up -d postgres
```

### 3. Run Database Migrations
```bash
npm run migrate
```
This will create both `digital_wallet` and `digital_wallet_test` databases and apply all 8 migrations.

### 4. Start the Application
```bash
# Development mode
npm run dev

# Production build and run
npm run build
npm start
```
The server starts at `http://localhost:3000`.
Visit `http://localhost:3000/docs` for the interactive OpenAPI Swagger UI.

---

## Running the Automated Test Suite

The test suite includes integration tests, idempotency checks, FX conversion tests, outbox event tests, and a **100-parallel-transfers concurrency test**:

```bash
npm test
```

### Test Coverage

| Test Suite | What It Proves |
|---|---|
| `auth.test.ts` | Registration, login, JWT token generation, duplicate email rejection |
| `accounts.test.ts` | Account creation, balance queries, deposits with double-entry |
| `transfers.test.ts` | Atomic transfers, authorization checks, insufficient funds, reversals |
| `idempotency.test.ts` | Duplicate transfers return cached response without double-spending |
| `fx-outbox.test.ts` | Cross-currency FX conversion (USD→EUR at 0.92), outbox event emission & dispatch, Chart of Accounts types |
| `parallel-transfers.test.ts` | 100 concurrent bi-directional transfers: zero deadlocks, exact balance invariance, $\Sigma\text{ledger} = 0$ |

---

## Scripts & Tooling

```bash
npm run dev          # Start development server (port 3000)
npm run build        # Compile TypeScript to dist/
npm start            # Run production build
npm run migrate      # Run all database migrations
npm run reconcile    # Audit: compare cached balances vs. ledger SUM
npm run demo         # Run live end-to-end demo script
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage # Generate coverage report
```

### Load Testing
```bash
k6 run load-tests/k6-transfers.js
```

---

## Project Structure

```
digital-wallet/
├── migrations/                    # Sequential SQL migrations (001-008)
│   ├── 001_create_users.sql
│   ├── 002_create_accounts.sql
│   ├── 003_create_transfers.sql
│   ├── 004_create_ledger_entries.sql
│   ├── 005_prevent_ledger_tampering.sql
│   ├── 006_chart_of_accounts.sql       # Account types & system accounts
│   ├── 007_exchange_rates.sql          # FX rates table & seeded pairs
│   └── 008_outbox_events.sql           # Transactional outbox table
├── src/
│   ├── config/
│   │   ├── database.ts                 # pg Pool, withTransaction helper
│   │   └── env.ts                      # Zod-validated environment config
│   ├── modules/
│   │   ├── auth/                       # Register, Login, JWT
│   │   ├── accounts/                   # CRUD, Deposits with double-entry
│   │   ├── transfers/                  # Atomic transfers, FX, reversals
│   │   ├── ledger/                     # Cursor-paginated transaction queries
│   │   ├── fx/                         # FX rate lookup & currency conversion
│   │   └── outbox/                     # Event emission & background dispatch
│   ├── plugins/
│   │   ├── auth.plugin.ts              # JWT verification hook
│   │   ├── error-handler.ts            # Centralized error handler
│   │   ├── rate-limit.plugin.ts        # Per-endpoint rate limiting
│   │   └── swagger.plugin.ts           # OpenAPI / Swagger UI
│   ├── utils/
│   │   ├── errors.ts                   # Custom error classes
│   │   └── logger.ts                   # Pino structured logger
│   ├── app.ts                          # Fastify app builder
│   └── server.ts                       # Entry point with graceful shutdown
├── scripts/
│   ├── migrate.ts                      # Migration runner
│   ├── setup-db.ts                     # DB creation + migration
│   ├── reconcile.ts                    # Balance vs. ledger audit
│   └── demo.ts                         # Live end-to-end demo
├── tests/
│   ├── helpers/test-db.ts              # Test setup, fixtures, cleanup
│   ├── integration/                    # Auth, accounts, transfers, FX, outbox tests
│   └── concurrency/                    # 100-parallel-transfer test
├── load-tests/
│   └── k6-transfers.js                 # k6 load testing script
├── docker-compose.yml                  # PostgreSQL 16 container
├── Dockerfile                          # Multi-stage production build
├── package.json
├── tsconfig.json
└── jest.config.ts
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 + TypeScript 5.7 |
| Framework | Fastify 5 |
| Database | PostgreSQL 16 (raw `pg` — no ORM) |
| Validation | Zod |
| Auth | `@fastify/jwt` + bcryptjs |
| API Docs | `@fastify/swagger` + `@fastify/swagger-ui` |
| Rate Limiting | `@fastify/rate-limit` |
| Testing | Jest + Supertest (via Fastify `inject`) |
| Logging | Pino + pino-pretty |
| Containerization | Docker + Docker Compose |
| Load Testing | k6 |

---

## Next Steps / Roadmap

The following improvements would take this project to a truly enterprise-grade financial platform:

### 🔴 High Priority

1. **Two-Phase Transfers (Auth & Capture)**
   - Support `AUTHORIZED` → `CAPTURED` / `VOIDED` lifecycle
   - Split `balance` into `available_balance` and `settled_balance` on accounts
   - Enables payment hold/capture flows (e-commerce, pre-auth)

2. **Automated Background Reconciliation Daemon**
   - Package `reconcile.ts` as a BullMQ scheduled worker or cron job
   - Auto-freeze accounts on discrepancy detection
   - Alert via Slack/PagerDuty webhook on balance mismatch

3. **Webhook Delivery System**
   - Outbox worker dispatches events to registered webhook URLs
   - HMAC-SHA256 signed payloads for verification
   - Exponential backoff retry with dead-letter queue

### 🟡 Medium Priority

4. **Account Freezing & KYC States**
   - `account_status` enum: `ACTIVE`, `FROZEN`, `SUSPENDED`, `CLOSED`
   - Block transfers from/to non-active accounts
   - Admin endpoints for freeze/unfreeze with audit trail

5. **Prometheus Metrics & OpenTelemetry**
   - `/metrics` endpoint: `wallet_transfers_total`, `transfer_latency_seconds`, `pg_pool_idle_connections`
   - Distributed tracing with trace IDs propagated across DB queries
   - Grafana dashboard templates

6. **Admin Dashboard API**
   - System-wide stats: total users, total volume, daily transaction count
   - List all accounts (paginated), search by email
   - Manual transfer reversal and account freeze from admin context

### 🟢 Nice to Have

7. **Transaction Fee Engine**
   - Configurable fee rules (flat fee, percentage, tiered)
   - Fees deducted atomically and credited to `SYSTEM_FEES_REVENUE` account
   - Fee schedule per currency or account tier

8. **Scheduled / Recurring Transfers**
   - Cron-based scheduled transfers with BullMQ
   - Recurring payment support (subscriptions, payroll)

9. **Multi-Tenant Support**
   - Tenant-scoped data isolation via `tenant_id` column or PostgreSQL Row-Level Security
   - Separate API keys per tenant

10. **Audit Log Table**
    - Dedicated `audit_logs` table tracking every admin action, config change, and account state transition
    - Immutable, append-only, indexed by timestamp and actor

---

## License

MIT
