import { pool } from '../../config/database';
import { BadRequestError } from '../../utils/errors';
import { accountsService } from '../accounts/accounts.service';
import { GetTransactionsQuery } from './ledger.schema';

export interface CursorData {
  createdAt: string;
  id: string;
}

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorData {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.createdAt || !parsed.id) {
      throw new Error('Malformed cursor payload');
    }
    return parsed;
  } catch (err) {
    throw new BadRequestError('Invalid pagination cursor');
  }
}

export class LedgerService {
  /**
   * Fetch paginated transactions for an account using cursor pagination and optional filters.
   */
  async getAccountTransactions(
    accountId: string,
    userId: string,
    query: GetTransactionsQuery
  ) {
    // 1. Authorization: check account ownership
    await accountsService.getAccountById(accountId, userId);

    const limit = query.limit;
    const values: any[] = [accountId];
    let queryIndex = 2;

    let whereClause = `WHERE le.account_id = $1`;

    // 2. Filter by type (DEBIT / CREDIT)
    if (query.type === 'DEBIT') {
      whereClause += ` AND le.amount < 0`;
    } else if (query.type === 'CREDIT') {
      whereClause += ` AND le.amount > 0`;
    }

    // 3. Filter by date range
    if (query.startDate) {
      whereClause += ` AND le.created_at >= $${queryIndex}`;
      values.push(new Date(query.startDate));
      queryIndex++;
    }

    if (query.endDate) {
      whereClause += ` AND le.created_at <= $${queryIndex}`;
      values.push(new Date(query.endDate));
      queryIndex++;
    }

    // 4. Cursor Pagination (created_at DESC, id DESC)
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      whereClause += ` AND (le.created_at < $${queryIndex} OR (le.created_at = $${queryIndex} AND le.id < $${queryIndex + 1}))`;
      values.push(new Date(decoded.createdAt), decoded.id);
      queryIndex += 2;
    }

    // Fetch limit + 1 to check if there is a next page
    values.push(limit + 1);
    const sql = `
      SELECT
        le.id,
        le.transfer_id,
        le.account_id,
        le.amount,
        le.created_at,
        t.from_account,
        t.to_account,
        t.status as transfer_status,
        t.idempotency_key
      FROM ledger_entries le
      INNER JOIN transfers t ON t.id = le.transfer_id
      ${whereClause}
      ORDER BY le.created_at DESC, le.id DESC
      LIMIT $${queryIndex}
    `;

    const result = await pool.query(sql, values);
    const rows = result.rows;

    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasNextPage && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = encodeCursor({
        createdAt: new Date(lastItem.created_at).toISOString(),
        id: lastItem.id,
      });
    }

    return {
      transactions: items.map((row) => {
        const rawAmount = parseInt(row.amount, 10);
        return {
          id: row.id,
          transferId: row.transfer_id,
          accountId: row.account_id,
          amount: rawAmount,
          type: rawAmount < 0 ? 'DEBIT' : 'CREDIT',
          fromAccount: row.from_account,
          toAccount: row.to_account,
          status: row.transfer_status,
          createdAt: row.created_at,
        };
      }),
      pagination: {
        limit,
        hasNextPage,
        nextCursor,
      },
    };
  }
}

export const ledgerService = new LedgerService();
