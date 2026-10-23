import { PoolClient } from 'pg';
import { pool } from '../../config/database';
import { logger } from '../../utils/logger';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, any>;
}

export interface OutboxEventRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  retry_count: number;
  created_at: Date;
  published_at: Date | null;
}

export class OutboxService {
  /**
   * Atomic Event Emission: Inserts event into outbox inside the caller's active database transaction.
   */
  async emitEvent(client: PoolClient, input: OutboxEventInput): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING id`,
      [input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload)]
    );
    return res.rows[0].id;
  }

  /**
   * Process and dispatch pending outbox events (simulates publishing to Kafka/RabbitMQ).
   */
  async publishPendingEvents(batchSize = 50): Promise<number> {
    const client = await pool.connect();
    try {
      // Lock a batch of pending events using FOR UPDATE SKIP LOCKED
      const res = await client.query<OutboxEventRecord>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, retry_count
         FROM outbox_events
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );

      if (res.rowCount === 0) {
        return 0;
      }

      for (const event of res.rows) {
        try {
          // Dispatch event to logger / external message bus
          logger.info(
            {
              outbox: true,
              eventId: event.id,
              eventType: event.event_type,
              aggregateId: event.aggregate_id,
            },
            `Dispatched outbox event: ${event.event_type}`
          );

          // Mark as published
          await client.query(
            `UPDATE outbox_events
             SET status = 'PUBLISHED', published_at = NOW()
             WHERE id = $1`,
            [event.id]
          );
        } catch (dispatchErr) {
          logger.error({ dispatchErr, eventId: event.id }, 'Failed publishing outbox event');
          await client.query(
            `UPDATE outbox_events
             SET status = 'FAILED', retry_count = retry_count + 1
             WHERE id = $1`,
            [event.id]
          );
        }
      }

      return res.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Query recent outbox events
   */
  async getEvents(limit = 50) {
    const res = await pool.query<OutboxEventRecord>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status, retry_count, created_at, published_at
       FROM outbox_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return res.rows.map((r) => ({
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: r.payload,
      status: r.status,
      retryCount: r.retry_count,
      createdAt: r.created_at,
      publishedAt: r.published_at,
    }));
  }

  private pollerTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  /**
   * Start automated background poller worker
   */
  startPoller(intervalMs = 3000) {
    if (this.pollerTimer) return;
    this.pollerTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await this.publishPendingEvents();
      } catch (err) {
        logger.error({ err }, 'Error during automated outbox poller run');
      } finally {
        this.isPolling = false;
      }
    }, intervalMs);
    logger.info({ intervalMs }, 'Outbox background poller worker started');
  }

  /**
   * Stop background poller worker
   */
  stopPoller() {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer);
      this.pollerTimer = null;
      logger.info('Outbox background poller worker stopped');
    }
  }
}

export const outboxService = new OutboxService();
