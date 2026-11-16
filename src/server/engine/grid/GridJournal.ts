import {
  AuditLog,
  AuditLogType,
  GridArbitrageEvent,
  GridBotInstance,
  OrderRecord,
} from '../../../shared/types';
import { JsonStore } from '../../store';

/**
 * How many arbitrage events the journal keeps. This was 500 — a day of history on a busy desk,
 * and the only per-round-trip record (`botId`, prices, `netProfitUSDT`) that survives a bot row
 * being deleted or trimmed. At ~300 bytes per event, 20 000 is a few MB and covers every round
 * trip of a few hundred grid bots, which is what the fiscal export reads.
 */
export const GRID_ARBITRAGE_MAX_EVENTS = 20_000;

/**
 * The audit log is the second source of truth for a closed bot (`GRID_ARBITRAGE_PROFIT` lines,
 * stop reasons, create/stop events). It used to hold 500 lines — less than one day — so the
 * trail needed to reconstruct a deleted bot was gone before it was needed.
 */
export const GRID_AUDIT_MAX_EVENTS = 5_000;

/** A terminal snapshot of a bot, kept forever, independent of `grid_bots.json`. */
export interface ArchivedGridBot extends GridBotInstance {
  /** When this snapshot was taken (ms). */
  archivedAt: number;
}

/**
 * Append-only merge of terminal bots into the archive.
 *
 * `saveBots()` overwrites `grid_bots.json` with whatever the engine still holds, so a bot that
 * is deleted (or dropped by any other path) disappears from that file for good. The archive is
 * keyed by `botId` and never removes an entry, so deleting a bot from the UI cannot delete its
 * history.
 *
 * Only terminal bots are archived: a RUNNING bot is already in `grid_bots.json`, and archiving
 * it would rewrite a growing file on every 200 ms flush for no gain. A bot is archived the
 * moment it stops — and deleting is only allowed for stopped bots — so the archive is always
 * complete before a delete can happen.
 *
 * Pure on purpose (no I/O): the caller decides when to flush.
 *
 * @returns true when the archive changed and needs persisting.
 */
export function mergeBotsIntoArchive(
  archive: Record<string, ArchivedGridBot>,
  bots: GridBotInstance[],
  now: number
): boolean {
  let changed = false;
  for (const bot of bots) {
    if (!bot?.botId) continue;
    if (bot.status === 'RUNNING') continue;
    const prev = archive[bot.botId];
    const newer =
      !prev ||
      (bot.updatedAt || 0) > (prev.updatedAt || 0) ||
      (bot.deletedAt || 0) !== (prev.deletedAt || 0) ||
      bot.status !== prev.status;
    if (!newer) continue;
    archive[bot.botId] = { ...bot, archivedAt: now };
    changed = true;
  }
  return changed;
}

export class GridJournal {
  private botsStore: JsonStore<GridBotInstance[]>;
  private botsArchiveStore: JsonStore<Record<string, ArchivedGridBot>>;
  private arbitragesStore: JsonStore<GridArbitrageEvent[]>;
  private ordersStore: JsonStore<OrderRecord[]>;
  private auditStore: JsonStore<AuditLog[]>;

  constructor() {
    this.botsStore = new JsonStore<GridBotInstance[]>('grid_bots.json', []);
    this.botsArchiveStore = new JsonStore<Record<string, ArchivedGridBot>>(
      'grid_bots_archive.json',
      {}
    );
    this.arbitragesStore = new JsonStore<GridArbitrageEvent[]>('grid_arbitrages.json', []);
    this.ordersStore = new JsonStore<OrderRecord[]>('orders.json', []);
    this.auditStore = new JsonStore<AuditLog[]>('audit.json', []);
  }

  public getBots(): GridBotInstance[] {
    return this.botsStore.get();
  }

  public saveBots(bots: GridBotInstance[]) {
    // Archive FIRST, then overwrite: if anything is dropped from the incoming list (a delete, a
    // reset, a bug), the terminal snapshot is already on disk.
    const archive = this.botsArchiveStore.get();
    if (mergeBotsIntoArchive(archive, bots, Date.now())) {
      this.botsArchiveStore.save(archive);
    }
    this.botsStore.save(bots);
  }

  /**
   * Every bot ever observed in a terminal state, newest first — including bots that were
   * soft-deleted or removed from `grid_bots.json` before this archive existed.
   */
  public getArchivedBots(): ArchivedGridBot[] {
    return Object.values(this.botsArchiveStore.get()).sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
    );
  }

  public recordArbitrage(event: GridArbitrageEvent) {
    const list = this.arbitragesStore.get();
    list.unshift(event);
    if (list.length > GRID_ARBITRAGE_MAX_EVENTS) list.length = GRID_ARBITRAGE_MAX_EVENTS;
    this.arbitragesStore.save(list);
  }

  public getArbitrages(limit: number = 500): GridArbitrageEvent[] {
    return this.arbitragesStore.get().slice(0, limit);
  }

  public clearArbitrages() {
    this.arbitragesStore.save([]);
  }

  public recordOrder(order: OrderRecord) {
    const orders = this.ordersStore.get();
    const existingIdx = orders.findIndex((o) => o.id === order.id);
    if (existingIdx >= 0) {
      orders[existingIdx] = order;
    } else {
      orders.unshift(order);
    }
    if (orders.length > 5000) {
      // Retain all FILLED orders and trim oldest non-FILLED orders first
      const filled = orders.filter((o) => o.status === 'FILLED');
      const others = orders.filter((o) => o.status !== 'FILLED');
      const maxOthers = Math.max(0, 5000 - filled.length);
      const merged = [...filled, ...others.slice(0, maxOthers)].sort(
        (a, b) => (b.updatedTime || b.createdTime) - (a.updatedTime || a.createdTime)
      );
      this.ordersStore.save(merged.slice(0, 5000));
      return;
    }
    this.ordersStore.save(orders);
  }

  public getOrders(): OrderRecord[] {
    return this.ordersStore.get();
  }

  public getFilledOrdersByBot(botId: string): OrderRecord[] {
    return this.ordersStore
      .get()
      .filter((o) => o.botId === botId && o.status === 'FILLED');
  }

  public clearOrders() {
    this.ordersStore.save([]);
  }

  public logAudit(type: AuditLogType, message: string, details?: any) {
    const logs = this.auditStore.get();
    logs.unshift({
      id: `grid_log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      type,
      message,
      details,
    });
    if (logs.length > GRID_AUDIT_MAX_EVENTS) logs.length = GRID_AUDIT_MAX_EVENTS;
    this.auditStore.save(logs);
  }

  public getAuditLogs(): AuditLog[] {
    return this.auditStore.get();
  }

  public clearAuditLogs() {
    this.auditStore.save([]);
  }
}
