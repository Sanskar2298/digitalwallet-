import crypto, { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/database';
import {
  BadRequestError,
  ForbiddenError,
  InsufficientFundsError,
  NotFoundError,
  UnprocessableEntityError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import { AccountRecord } from '../accounts/accounts.service';
import { CreateTransferInput } from './transfers.schema';
import { fxService } from '../fx/fx.service';
import { outboxService } from '../outbox/outbox.service';

export interface TransferRecord {
  id: string;
  user_id: string | null;
  from_account: string | null;
  to_account: string;
  amount: string;
  destination_amount: string | null;
  exchange_rate: string | null;
  fee_amount: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
  idempotency_key: string;
  request_hash: string | null;
  response_payload: any;
  created_at: Date;
}

export class TransfersService {
  /**
   * Compute SHA-256 fingerprint of transfer request parameters.
   */
  private computeRequestHash(userId: string, input: CreateTransferInput): string {
    const canonical = `${userId}:${input.fromAccountId}:${input.toAccountId}:${input.amount}`;
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Helper to retrieve or verify system accounts (SYSTEM_FX_CLEARING, SYSTEM_FEES_REVENUE)
   */
  private async getSystemAccount(
    client: PoolClient,
    accountType: 'SYSTEM_FX_CLEARING' | 'SYSTEM_FEES_REVENUE',
    currency: string
  ): Promise<AccountRecord> {
    const res = await client.query<AccountRecord>(
      `SELECT id, user_id, currency, balance, account_type, created_at
       FROM accounts
       WHERE account_type = $1 AND currency = $2
       LIMIT 1
       FOR UPDATE`,
      [accountType, currency]
    );

    if (res.rowCount && res.rowCount > 0) {
      return res.rows[0];
    }

    // Auto-provision if not already seeded for this currency
    const insertRes = await client.query<AccountRecord>(
      `INSERT INTO accounts (user_id, currency, balance, account_type)
       VALUES (NULL, $1, 10000000000, $2)
       RETURNING id, user_id, currency, balance, account_type, created_at`,
      [currency, accountType]
    );
    return insertRes.rows[0];
  }

  /**
   * Execute atomic transfer with strict double-entry ledger bookkeeping.
   *
   * Single Database Transaction:
   * 1. Check idempotency: match request_hash. If mismatch -> 422 Unprocessable Entity.
   * 2. Lock accounts in strictly ascending ID order to prevent deadlocks.
   * 3. Validate ownership & funds.
   * 4. Multi-currency handling:
   *    - Uses FX clearing accounts:
   *      Leg 1 (Source Currency): User Wallet debit (-X), System FX Clearing credit (+X) [Σ = 0]
   *      Leg 2 (Target Currency): System FX Clearing debit (-Y), User Wallet credit (+Y) [Σ = 0]
   *    - Handles ISO 4217 minor-unit exponents (e.g. USD cents to JPY whole units).
   * 5. Outbox event emission.
   * 6. Commit or rollback.
   */
  async executeTransfer(userId: string, input: CreateTransferInput, idempotencyKey: string) {
    const requestHash = this.computeRequestHash(userId, input);

    try {
      return await withTransaction(async (client) => {
        // 1. Check if idempotency key already exists
        const existingRes = await client.query<TransferRecord>(
          `SELECT id, user_id, status, request_hash, response_payload
           FROM transfers
           WHERE idempotency_key = $1`,
          [idempotencyKey]
        );

        if (existingRes.rowCount && existingRes.rowCount > 0) {
          const existing = existingRes.rows[0];

          // Stripe-style payload validation: if same key is reused with different payload, return 422
          if (existing.request_hash && existing.request_hash !== requestHash) {
            throw new UnprocessableEntityError(
              'Idempotency key was previously used with a different request payload'
            );
          }

          logger.info(
            { idempotencyKey, transferId: existing.id, status: existing.status },
            'Idempotency key hit: returning previously committed transfer response'
          );
          return existing.response_payload || {
            message: 'Transfer already processed',
            transferId: existing.id,
            status: existing.status,
            idempotencyKey,
          };
        }

        // 2. Lock both customer accounts in ascending ID order to prevent deadlocks
        const [firstAccountId, secondAccountId] =
          input.fromAccountId < input.toAccountId
            ? [input.fromAccountId, input.toAccountId]
            : [input.toAccountId, input.fromAccountId];

        const lockRes = await client.query<AccountRecord>(
          `SELECT id, user_id, currency, balance, account_type, created_at
           FROM accounts
           WHERE id IN ($1, $2)
           ORDER BY id ASC
           FOR UPDATE`,
          [firstAccountId, secondAccountId]
        );

        if (lockRes.rowCount !== 2) {
          throw new NotFoundError('One or both accounts involved in the transfer do not exist');
        }

        const accountMap = new Map<string, AccountRecord>();
        for (const row of lockRes.rows) {
          accountMap.set(row.id, row);
        }

        const fromAccount = accountMap.get(input.fromAccountId)!;
        const toAccount = accountMap.get(input.toAccountId)!;

        // 3. Authorization check: caller must own fromAccount
        if (fromAccount.user_id !== userId) {
          throw new ForbiddenError('You do not have authorization to transfer funds from this account');
        }

        // 4. Sufficient funds check
        const currentBalance = parseInt(fromAccount.balance, 10);
        if (currentBalance < input.amount) {
          throw new InsufficientFundsError(
            `Insufficient funds. Current balance: ${currentBalance}, required: ${input.amount}`
          );
        }

        const isCrossCurrency = fromAccount.currency !== toAccount.currency;
        let exchangeRate = 1.0;
        let destinationAmount = input.amount;

        // 5. Insert transfer record
        if (isCrossCurrency) {
          const fx = await fxService.convert(input.amount, fromAccount.currency, toAccount.currency);
          exchangeRate = fx.rate;
          destinationAmount = fx.destinationAmount;
        }

        const transferInsertRes = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO transfers (user_id, from_account, to_account, amount, destination_amount, exchange_rate, status, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', $7, $8)
           RETURNING id, created_at`,
          [
            userId,
            input.fromAccountId,
            input.toAccountId,
            input.amount,
            destinationAmount,
            exchangeRate,
            idempotencyKey,
            requestHash,
          ]
        );
        const transfer = transferInsertRes.rows[0];

        let newFromBalance = 0;
        let newToBalance = 0;

        if (!isCrossCurrency) {
          // --- SAME-CURRENCY DIRECT DOUBLE ENTRY (2 entries, Σ = 0) ---
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, input.fromAccountId, -input.amount]
          );
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, input.toAccountId, input.amount]
          );

          const updatedFrom = await client.query<{ balance: string }>(
            `UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance`,
            [input.amount, input.fromAccountId]
          );
          const updatedTo = await client.query<{ balance: string }>(
            `UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
            [input.amount, input.toAccountId]
          );

          newFromBalance = parseInt(updatedFrom.rows[0].balance, 10);
          newToBalance = parseInt(updatedTo.rows[0].balance, 10);
        } else {
          // --- CROSS-CURRENCY TRUE DOUBLE-ENTRY VIA SYSTEM_FX_CLEARING (4 entries) ---
          // Currency 1 Leg (USD): Sender Debit (-amount), Source Clearing Credit (+amount) -> Σ = 0
          // Currency 2 Leg (EUR): Target Clearing Debit (-destinationAmount), Recipient Credit (+destinationAmount) -> Σ = 0
          const sourceClearing = await this.getSystemAccount(client, 'SYSTEM_FX_CLEARING', fromAccount.currency);
          const targetClearing = await this.getSystemAccount(client, 'SYSTEM_FX_CLEARING', toAccount.currency);

          // Leg 1 Entries
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, input.fromAccountId, -input.amount]
          );
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, sourceClearing.id, input.amount]
          );

          // Leg 2 Entries
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, targetClearing.id, -destinationAmount]
          );
          await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
            [transfer.id, input.toAccountId, destinationAmount]
          );

          // Update balances for all 4 accounts
          const updatedFrom = await client.query<{ balance: string }>(
            `UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance`,
            [input.amount, input.fromAccountId]
          );
          await client.query(
            `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
            [input.amount, sourceClearing.id]
          );
          await client.query(
            `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
            [destinationAmount, targetClearing.id]
          );
          const updatedTo = await client.query<{ balance: string }>(
            `UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
            [destinationAmount, input.toAccountId]
          );

          newFromBalance = parseInt(updatedFrom.rows[0].balance, 10);
          newToBalance = parseInt(updatedTo.rows[0].balance, 10);
        }

        const responsePayload = {
          message: isCrossCurrency ? 'Cross-currency transfer completed successfully' : 'Transfer completed successfully',
          transfer: {
            id: transfer.id,
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            amount: input.amount,
            sourceAmount: input.amount,
            sourceCurrency: fromAccount.currency,
            destinationAmount,
            destinationCurrency: toAccount.currency,
            exchangeRate,
            currency: fromAccount.currency,
            status: 'COMPLETED',
            idempotencyKey,
            createdAt: transfer.created_at,
          },
          fromAccountBalance: newFromBalance,
          toAccountBalance: newToBalance,
        };

        // Outbox event
        await outboxService.emitEvent(client, {
          aggregateType: 'TRANSFER',
          aggregateId: transfer.id,
          eventType: isCrossCurrency ? 'transfer.fx_cleared' : 'transfer.completed',
          payload: {
            transferId: transfer.id,
            userId,
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            sourceAmount: input.amount,
            sourceCurrency: fromAccount.currency,
            destinationAmount,
            destinationCurrency: toAccount.currency,
            exchangeRate,
            idempotencyKey,
          },
        });

        // Store response payload
        await client.query(
          `UPDATE transfers SET response_payload = $1 WHERE id = $2`,
          [JSON.stringify(responsePayload), transfer.id]
        );

        logger.info(
          {
            audit: true,
            event: isCrossCurrency ? 'TRANSFER_FX_CLEARED' : 'TRANSFER_COMPLETED',
            transferId: transfer.id,
            userId,
            isCrossCurrency,
            sourceAmount: input.amount,
            destinationAmount,
          },
          'Double-entry transfer finalized successfully'
        );

        return responsePayload;
      });
    } catch (err: any) {
      if (
        err.code === '23505' &&
        (err.constraint?.includes('idempotency') || err.detail?.includes('idempotency_key'))
      ) {
        // Concurrent race condition: wait for winner's commit
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 40));
          const res = await pool.query<TransferRecord>(
            `SELECT request_hash, response_payload FROM transfers WHERE idempotency_key = $1`,
            [idempotencyKey]
          );
          if (res.rowCount && res.rowCount > 0 && res.rows[0].response_payload) {
            if (res.rows[0].request_hash && res.rows[0].request_hash !== requestHash) {
              throw new UnprocessableEntityError(
                'Idempotency key was previously used with a different request payload'
              );
            }
            return res.rows[0].response_payload;
          }
        }
      }
      throw err;
    }
  }

  /**
   * Reverse an existing transfer.
   * Authorization: Only the original sender (or an admin) can initiate a reversal/refund.
   * Reversal preserves append-only integrity with offsetting ledger entries.
   */
  async reverseTransfer(transferId: string, userId: string) {
    const reversalIdempotencyKey = `reversal-${transferId}-${randomUUID()}`;

    return await withTransaction(async (client) => {
      const transferRes = await client.query<TransferRecord>(
        `SELECT id, user_id, from_account, to_account, amount, destination_amount, status, created_at
         FROM transfers
         WHERE id = $1
         FOR UPDATE`,
        [transferId]
      );

      if (transferRes.rowCount === 0) {
        throw new NotFoundError('Transfer not found');
      }

      const originalTransfer = transferRes.rows[0];
      if (originalTransfer.status !== 'COMPLETED') {
        throw new UnprocessableEntityError(`Cannot reverse transfer with status ${originalTransfer.status}`);
      }

      if (!originalTransfer.from_account) {
        throw new UnprocessableEntityError('Cannot reverse an external deposit transfer');
      }

      const fromAccountId = originalTransfer.from_account;
      const toAccountId = originalTransfer.to_account;
      const sourceAmount = parseInt(originalTransfer.amount, 10);
      const destinationAmount = originalTransfer.destination_amount
        ? parseInt(originalTransfer.destination_amount, 10)
        : sourceAmount;

      // Lock accounts
      const [firstId, secondId] = fromAccountId < toAccountId
        ? [fromAccountId, toAccountId]
        : [toAccountId, fromAccountId];

      const lockRes = await client.query<AccountRecord>(
        `SELECT id, user_id, currency, balance, account_type
         FROM accounts
         WHERE id IN ($1, $2)
         ORDER BY id ASC
         FOR UPDATE`,
        [firstId, secondId]
      );

      const accountMap = new Map<string, AccountRecord>();
      for (const row of lockRes.rows) {
        accountMap.set(row.id, row);
      }

      const originalFrom = accountMap.get(fromAccountId)!;
      const originalTo = accountMap.get(toAccountId)!;

      // Caller authorization: Only the original sender can initiate reversal
      if (originalFrom.user_id !== userId && originalTransfer.user_id !== userId) {
        throw new ForbiddenError('Only the original sender or an authorized dispute officer can reverse this transfer');
      }

      // Check recipient has enough balance to refund
      const recipientBalance = parseInt(originalTo.balance, 10);
      if (recipientBalance < destinationAmount) {
        throw new InsufficientFundsError('Recipient account has insufficient funds to process the reversal');
      }

      const isCrossCurrency = originalFrom.currency !== originalTo.currency;

      // Insert reversal transfer
      const reversalTransferRes = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO transfers (user_id, from_account, to_account, amount, destination_amount, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'REVERSED', $6)
         RETURNING id, created_at`,
        [userId, toAccountId, fromAccountId, destinationAmount, sourceAmount, reversalIdempotencyKey]
      );
      const reversalTransfer = reversalTransferRes.rows[0];

      // Mark original transfer as REVERSED
      await client.query(`UPDATE transfers SET status = 'REVERSED' WHERE id = $1`, [transferId]);

      let senderNewBalance = 0;
      let recipientNewBalance = 0;

      if (!isCrossCurrency) {
        // Direct reversal ledger entries
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, toAccountId, -sourceAmount]
        );
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, fromAccountId, sourceAmount]
        );

        const updatedRecipient = await client.query<{ balance: string }>(
          `UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance`,
          [sourceAmount, toAccountId]
        );
        const updatedSender = await client.query<{ balance: string }>(
          `UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
          [sourceAmount, fromAccountId]
        );

        recipientNewBalance = parseInt(updatedRecipient.rows[0].balance, 10);
        senderNewBalance = parseInt(updatedSender.rows[0].balance, 10);
      } else {
        // Cross-currency balanced reversal using clearing accounts
        const targetClearing = await this.getSystemAccount(client, 'SYSTEM_FX_CLEARING', originalTo.currency);
        const sourceClearing = await this.getSystemAccount(client, 'SYSTEM_FX_CLEARING', originalFrom.currency);

        // Reverse recipient leg
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, toAccountId, -destinationAmount]
        );
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, targetClearing.id, destinationAmount]
        );

        // Reverse sender leg
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, sourceClearing.id, -sourceAmount]
        );
        await client.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount) VALUES ($1, $2, $3)`,
          [reversalTransfer.id, fromAccountId, sourceAmount]
        );

        const updatedRecipient = await client.query<{ balance: string }>(
          `UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING balance`,
          [destinationAmount, toAccountId]
        );
        await client.query(
          `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
          [destinationAmount, targetClearing.id]
        );
        await client.query(
          `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
          [sourceAmount, sourceClearing.id]
        );
        const updatedSender = await client.query<{ balance: string }>(
          `UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
          [sourceAmount, fromAccountId]
        );

        recipientNewBalance = parseInt(updatedRecipient.rows[0].balance, 10);
        senderNewBalance = parseInt(updatedSender.rows[0].balance, 10);
      }

      const responsePayload = {
        message: 'Transfer reversed successfully',
        originalTransferId: transferId,
        reversalTransferId: reversalTransfer.id,
        amount: sourceAmount,
        destinationAmount,
        senderNewBalance,
        recipientNewBalance,
      };

      // Outbox event
      await outboxService.emitEvent(client, {
        aggregateType: 'TRANSFER',
        aggregateId: reversalTransfer.id,
        eventType: 'transfer.reversed',
        payload: {
          originalTransferId: transferId,
          reversalTransferId: reversalTransfer.id,
          fromAccountId: toAccountId,
          toAccountId: fromAccountId,
          amount: sourceAmount,
        },
      });

      return responsePayload;
    });
  }
}

export const transfersService = new TransfersService();
