import { randomUUID } from 'crypto';
import { pool, withTransaction } from '../../config/database';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { CreateAccountInput } from './accounts.schema';
import { outboxService } from '../outbox/outbox.service';

export interface AccountRecord {
  id: string;
  user_id: string | null;
  currency: string;
  balance: string; // raw pg returns BIGINT as string to avoid precision loss
  account_type: 'CUSTOMER_WALLET' | 'SYSTEM_BANK_CASH' | 'SYSTEM_FX_CLEARING' | 'SYSTEM_FEES_REVENUE';
  created_at: Date;
}

export class AccountsService {
  /**
   * Create a new wallet account for the authenticated user
   */
  async createAccount(userId: string, input: CreateAccountInput) {
    const result = await pool.query<AccountRecord>(
      `INSERT INTO accounts (user_id, currency, balance, account_type)
       VALUES ($1, $2, 0, 'CUSTOMER_WALLET')
       RETURNING id, user_id, currency, balance, account_type, created_at`,
      [userId, input.currency]
    );

    const acc = result.rows[0];
    return {
      id: acc.id,
      userId: acc.user_id,
      currency: acc.currency,
      balance: parseInt(acc.balance, 10),
      accountType: acc.account_type,
      createdAt: acc.created_at,
    };
  }

  /**
   * Fetch an account by ID with ownership authorization check
   */
  async getAccountById(accountId: string, userId: string) {
    const result = await pool.query<AccountRecord>(
      `SELECT id, user_id, currency, balance, created_at
       FROM accounts
       WHERE id = $1`,
      [accountId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Account not found');
    }

    const acc = result.rows[0];
    if (acc.user_id !== userId) {
      throw new ForbiddenError('You are not authorized to view this account');
    }

    return {
      id: acc.id,
      userId: acc.user_id,
      currency: acc.currency,
      balance: parseInt(acc.balance, 10),
      createdAt: acc.created_at,
    };
  }

  /**
   * Deposit money into an account atomically with double-entry ledger bookkeeping.
   * from_account is NULL (representing external system mint / deposit).
   */
  async deposit(accountId: string, userId: string, amount: number, customIdempotencyKey?: string) {
    const idempotencyKey = customIdempotencyKey || `deposit-${randomUUID()}`;

    return await withTransaction(async (client) => {
      // 1. Check idempotency if key was provided
      if (customIdempotencyKey) {
        const existing = await client.query(
          `SELECT response_payload FROM transfers WHERE idempotency_key = $1`,
          [customIdempotencyKey]
        );
        if (existing.rowCount && existing.rowCount > 0 && existing.rows[0].response_payload) {
          return existing.rows[0].response_payload;
        }
      }

      // 2. Lock account with SELECT ... FOR UPDATE
      const accRes = await client.query<AccountRecord>(
        `SELECT id, user_id, currency, balance, created_at
         FROM accounts
         WHERE id = $1
         FOR UPDATE`,
        [accountId]
      );

      if (accRes.rowCount === 0) {
        throw new NotFoundError('Account not found');
      }

      const acc = accRes.rows[0];
      if (acc.user_id !== userId) {
        throw new ForbiddenError('You are not authorized to deposit into this account');
      }

      // 3. Insert transfer record
      const transferRes = await client.query(
        `INSERT INTO transfers (from_account, to_account, amount, status, idempotency_key)
         VALUES (NULL, $1, $2, 'COMPLETED', $3)
         RETURNING id, created_at`,
        [accountId, amount, idempotencyKey]
      );
      const transfer = transferRes.rows[0];

      // 4. Insert credit entry to ledger (+amount)
      await client.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, amount)
         VALUES ($1, $2, $3)`,
        [transfer.id, accountId, amount]
      );

      // 5. Update account balance
      const updatedRes = await client.query<AccountRecord>(
        `UPDATE accounts
         SET balance = balance + $1
         WHERE id = $2
         RETURNING id, user_id, currency, balance, created_at`,
        [amount, accountId]
      );
      const updatedAcc = updatedRes.rows[0];

      const response = {
        message: 'Deposit successful',
        transferId: transfer.id,
        account: {
          id: updatedAcc.id,
          userId: updatedAcc.user_id,
          currency: updatedAcc.currency,
          balance: parseInt(updatedAcc.balance, 10),
          createdAt: updatedAcc.created_at,
        },
        depositedAmount: amount,
        idempotencyKey,
      };

      // 6. Emit transactional outbox event
      await outboxService.emitEvent(client, {
        aggregateType: 'ACCOUNT',
        aggregateId: accountId,
        eventType: 'deposit.completed',
        payload: {
          accountId,
          userId,
          amount,
          newBalance: parseInt(updatedAcc.balance, 10),
          transferId: transfer.id,
          idempotencyKey,
        },
      });

      // 7. Cache idempotency response payload
      await client.query(
        `UPDATE transfers SET response_payload = $1 WHERE id = $2`,
        [JSON.stringify(response), transfer.id]
      );

      return response;
    });
  }
}

export const accountsService = new AccountsService();
