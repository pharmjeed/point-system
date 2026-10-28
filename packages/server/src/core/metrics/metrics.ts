import { createServer, type Server } from 'node:http';
import client from 'prom-client';

/**
 * The binding metric catalog (05 §12.2). Names are created here only; modules import the instances.
 * No high-cardinality labels (no ticket or user ids).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'point_process_' });

const h = (name: string, help: string, labelNames: string[] = [], buckets?: number[]) =>
  new client.Histogram({ name, help, labelNames, registers: [registry], ...(buckets ? { buckets } : {}) });
const c = (name: string, help: string, labelNames: string[] = []) =>
  new client.Counter({ name, help, labelNames, registers: [registry] });
const g = (name: string, help: string, labelNames: string[] = []) =>
  new client.Gauge({ name, help, labelNames, registers: [registry] });

const FAST = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const HUMAN = [1, 5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600];

export const metrics = {
  httpDuration: h(
    'point_http_request_duration_seconds',
    'HTTP commands and queries',
    ['route', 'status'],
    FAST,
  ),
  retrievalIngest: h(
    'point_retrieval_request_ingest_seconds',
    'Webhook button press to committed retrieval cycle',
    [],
    FAST,
  ),
  dispatchPublish: h(
    'point_dispatch_publish_seconds',
    'Commit of assignment/offer to WebSocket publish',
    [],
    FAST,
  ),
  dispatchTimeToClaim: h(
    'point_dispatch_time_to_claim_seconds',
    'Queue entry to confirmed accept',
    [],
    HUMAN,
  ),
  dispatchPassDuration: h('point_dispatch_pass_duration_seconds', 'Dispatch pass duration', ['reason'], FAST),
  dispatchPoolLockWait: h(
    'point_dispatch_pool_lock_wait_seconds',
    'Wait for the dispatch pool lock',
    [],
    FAST,
  ),
  dispatchOffers: c('point_dispatch_offers_total', 'Single offers and broadcasts by outcome', [
    'mode',
    'outcome',
  ]),
  dispatchAcceptRejections: c('point_dispatch_accept_rejections_total', 'Accept rejections by code', [
    'code',
  ]),
  dispatchEscalations: c('point_dispatch_escalations_total', 'Escalations to the supervisor'),
  dispatchOpenTasks: g('point_dispatch_open_tasks', 'Open retrieval tasks per pool', ['pool']),
  dispatchBroadcastOpen: g('point_dispatch_broadcast_open', 'Open broadcast rounds per pool', ['pool']),
  timerLag: h('point_timer_lag_seconds', 'Timer execution lag behind available_at', ['job'], FAST),
  outboxDue: g('point_outbox_due', 'Due unprocessed outbox rows', ['type']),
  outboxOldestPending: g('point_outbox_oldest_pending_seconds', 'Age of the oldest due row', ['type']),
  outboxEvents: c('point_outbox_events_total', 'Outbox processing results', ['type', 'status']),
  waSendDuration: h(
    'point_wa_send_duration_seconds',
    'Notification creation to provider acceptance',
    [],
    HUMAN,
  ),
  waDelivery: h('point_wa_delivery_seconds', 'Provider acceptance to delivered', [], HUMAN),
  waSend: c('point_wa_send_total', 'WhatsApp send attempts', ['outcome', 'error_code']),
  waSkipped: c('point_wa_skipped_total', 'Notifications not sent', ['reason']),
  waWebhookDuration: h('point_wa_webhook_duration_seconds', 'POST /webhooks/whatsapp handler time', [], FAST),
  waWebhookReceived: c('point_wa_webhook_received_total', 'Inbound webhook deliveries'),
  waWebhookLastReceived: g(
    'point_wa_webhook_last_received_timestamp_seconds',
    'Time of the last inbound webhook',
  ),
  waInboundBacklog: g('point_wa_inbound_backlog', 'Pending inbound rows'),
  waInboundLag: g('point_wa_inbound_processing_lag_seconds', 'Age of the oldest pending inbound row'),
  waButtonSenderMismatch: c('point_wa_button_sender_mismatch_total', 'Button presses from another number'),
  waStatusOrphan: c('point_wa_status_orphan_total', 'Statuses without a matching message'),
  waServiceMessagesMonth: g('point_wa_service_messages_month', 'Service messages this month'),
  waUniqueUsers24h: g(
    'point_wa_unique_users_24h_outside_window',
    'Unique users messaged outside the window in 24 h',
  ),
  waChannelHealth: g('point_wa_channel_health', '0 healthy · 1 degraded · 2 down'),
  pushSend: c('point_push_send_total', 'Web Push sends', ['outcome']),
  wsConnections: g('point_ws_connections', 'Open WebSocket connections', ['venue']),
  wsReconnects: c('point_ws_reconnects_total', 'WebSocket reconnects'),
  dbPoolInUse: g('point_db_pool_in_use', 'Database pool clients in use'),
  dbLockWait: h('point_db_lock_wait_seconds', 'Lock waits', [], FAST),
  dbTxRetries: c('point_db_tx_retries_total', 'Transaction retries', ['sqlstate']),
  driversOnDuty: g('point_drivers_on_duty', 'Drivers on duty', ['venue']),
  driversConnectionUncertain: g('point_drivers_connection_uncertain', 'Drivers with uncertain connection', [
    'venue',
  ]),
  backupLastSuccess: g('point_backup_last_success_timestamp_seconds', 'Last successful backup'),
  // PNT-090/091/094 additions (proposed for 05 §12.2, docs/progress/notes/audit-monitoring.md)
  outboxDead: g('point_outbox_dead', 'Outbox rows in status dead', ['type']),
  dispatchEligibleDrivers: g('point_dispatch_eligible_drivers', 'Drivers on duty and not on break per pool', [
    'pool',
  ]),
  tasksStuck: g('point_tasks_stuck', 'Tasks past their task_stuck threshold (14 §8)', ['type']),
  analyticsRejected: c(
    'point_analytics_rejected_total',
    'Analytics events dropped by the allow-list (15 §9.2, §13.1)',
    ['source', 'reason'],
  ),
  retentionRows: c('point_retention_rows_total', 'Rows purged, redacted or marked by job.retention_purge', [
    'step',
  ]),
  retentionDuration: h(
    'point_retention_duration_seconds',
    'Duration of a job.retention_purge run',
    [],
    HUMAN,
  ),
};

/** /metrics on the internal METRICS_PORT only (canon §9.8: internal network). */
export function startMetricsServer(port: number, host = '0.0.0.0'): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, host);
  return server;
}
