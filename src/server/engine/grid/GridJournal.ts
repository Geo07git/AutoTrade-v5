import {
  AuditLog,
  AuditLogType,
  GridArbitrageEvent,
  GridBotInstance,
  OrderRecord,
} from '../../../shared/types';
import { JsonStore } from '../../store';

export class GridJournal {
  private botsStore: JsonStore<GridBotInstance[]>;
  private arbitragesStore: JsonStore<GridArbitrageEvent[]>;
  private ordersStore: JsonStore<OrderRecord[]>;
  private auditStore: JsonStore<AuditLog[]>;

  constructor() {
    this.botsStore = new JsonStore<GridBotInstance[]>('grid_bots.json', []);
    this.arbitragesStore = new JsonStore<GridArbitrageEvent[]>('grid_arbitrages.json', []);
    this.ordersStore = new JsonStore<OrderRecord[]>('orders.json', []);
    this.auditStore = new JsonStore<AuditLog[]>('audit.json', []);
  }

  public getBots(): GridBotInstance[] {
    return this.botsStore.get();
  }

  public saveBots(bots: GridBotInstance[]) {
    this.botsStore.save(bots);
  }

  public recordArbitrage(event: GridArbitrageEvent) {
    const list = this.arbitragesStore.get();
    list.unshift(event);
    if (list.length > 500) list.length = 500;
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
    if (logs.length > 500) logs.length = 500;
    this.auditStore.save(logs);
  }

  public getAuditLogs(): AuditLog[] {
    return this.auditStore.get();
  }

  public clearAuditLogs() {
    this.auditStore.save([]);
  }
}
