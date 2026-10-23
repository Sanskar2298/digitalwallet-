import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface ReconciliationReport {
  timestamp: string;
  totalAccountsChecked: number;
  healthyAccounts: number;
  discrepantAccounts: number;
  globalLedgerSum: number;
  isSystemBalanced: boolean;
  discrepancies: Array<{
    accountId: string;
    userId: string;
    currency: string;
    cachedBalance: number;
    ledgerSum: number;
    difference: number;
  }>;
}

export async function runReconciliation(connectionString?: string): Promise<ReconciliationReport> {
  const dbUrl = connectionString || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5434/digital_wallet';
  const pool = new Pool({ connectionString: dbUrl });

  try {
    console.log(`\n======================================================`);
    console.log(`[Ledger Reconciliation] Starting reconciliation run...`);
    console.log(`Connected to: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`);
    console.log(`======================================================\n`);

    // 1. Account balance vs Ledger sum check for customer wallets
    const accountCheckSql = `
      SELECT
        a.id AS account_id,
        a.user_id,
        a.currency,
        a.account_type,
        a.balance AS cached_balance,
        COALESCE(SUM(le.amount), 0) AS ledger_sum,
        (a.balance - COALESCE(SUM(le.amount), 0)) AS diff
      FROM accounts a
      LEFT JOIN ledger_entries le ON le.account_id = a.id
      WHERE a.user_id IS NOT NULL
      GROUP BY a.id, a.user_id, a.currency, a.account_type, a.balance
      ORDER BY a.created_at ASC;
    `;

    const accountRes = await pool.query(accountCheckSql);
    const rows = accountRes.rows;

    const discrepancies: ReconciliationReport['discrepancies'] = [];

    for (const row of rows) {
      const cached = parseInt(row.cached_balance, 10);
      const ledgerSum = parseInt(row.ledger_sum, 10);
      const diff = parseInt(row.diff, 10);

      if (diff !== 0) {
        discrepancies.push({
          accountId: row.account_id,
          userId: row.user_id,
          currency: row.currency,
          cachedBalance: cached,
          ledgerSum,
          difference: diff,
        });
      }
    }

    // 2. Double-entry conservation checks:
    // Check 1: Across all completed peer transfers, sum(amount) grouped by currency must equal 0
    const currencySumSql = `
      SELECT a.currency, COALESCE(SUM(le.amount), 0) AS net_sum
      FROM ledger_entries le
      INNER JOIN accounts a ON a.id = le.account_id
      INNER JOIN transfers t ON t.id = le.transfer_id
      WHERE t.from_account IS NOT NULL
      GROUP BY a.currency;
    `;

    const currencyRes = await pool.query(currencySumSql);
    let currencyImbalance = false;
    let globalLedgerSum = 0;

    for (const cRow of currencyRes.rows) {
      const netSum = parseInt(cRow.net_sum, 10);
      globalLedgerSum += Math.abs(netSum);
      if (netSum !== 0) {
        currencyImbalance = true;
        console.error(`[ALERT] Currency ${cRow.currency} ledger out of balance by ${netSum}`);
      }
    }

    const report: ReconciliationReport = {
      timestamp: new Date().toISOString(),
      totalAccountsChecked: rows.length,
      healthyAccounts: rows.length - discrepancies.length,
      discrepantAccounts: discrepancies.length,
      globalLedgerSum,
      isSystemBalanced: discrepancies.length === 0 && !currencyImbalance && globalLedgerSum === 0,
      discrepancies,
    };

    console.log(`--- Reconciliation Summary ---`);
    console.log(`Timestamp:               ${report.timestamp}`);
    console.log(`Total Accounts Audited:  ${report.totalAccountsChecked}`);
    console.log(`Healthy Accounts:        ${report.healthyAccounts}`);
    console.log(`Discrepant Accounts:     ${report.discrepantAccounts}`);
    console.log(`Net Peer Ledger Sum:     ${report.globalLedgerSum} (Expected: 0)`);
    console.log(`Overall Health Status:   ${report.isSystemBalanced ? 'PERFECT / RECONCILED' : 'CRITICAL DISCREPANCY DETECTED'}\n`);

    if (discrepancies.length > 0) {
      console.error(`[ALERT] Discrepancies found in ${discrepancies.length} account(s):`);
      console.table(discrepancies);
    } else {
      console.log(`All account balances perfectly match immutable double-entry ledger sums.`);
    }

    return report;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runReconciliation()
    .then((report) => {
      if (!report.isSystemBalanced) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Reconciliation] Error executing job:', err);
      process.exit(1);
    });
}
