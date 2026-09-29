import { AuditLog, Position, OrderRecord, AuditLogType } from '../../shared/types';

export interface ResearchRecord {
  eventId: string;
  symbol: string;
  profile: string;
  side: string;
  signalTimestamp: number;
  decisionTimestamp: number;
  entryTimestamp: number | null;
  exitTimestamp: number | null;
  signalScore: number;
  rfProbability: number;
  rsi: number;
  atr: number;
  atrPct: number;
  rvol: number;
  volume24hUSDT: number;
  priceChange24hPct: number;
  openInterest: number;
  fundingRate: number;
  spreadPct: number;
  momentumScore: number;
  btcRegimePct: number;
  btcRegimeLabel: string;
  leverage: number;
  marginMode: string;
  sizeUSDT: number;
  signalPrice: number;
  fillPrice: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  estimatedSlippagePct: number;
  evaluationStatus: string; // EXECUTED | REJECTED_RISK | REJECTED_BALANCE | REJECTED_MAX_POSITIONS | REJECTED_OTHER | EXPIRED
  rejectionReason: string | null;
  realizedPnlPct: number | null;
  realizedPnlUsdt: number | null;
  fee: number | null;
  mae: number | null;
  mfe: number | null;
  holdingTimeMinutes: number | null;
  exitReason: string | null;
}

export class ResearchExportService {
  /**
   * Generates a strict read-only export dataset of all signals, candidates,
   * rejections, and executed/closed positions for offline ML research.
   */
  public static generateExportDataset(
    auditLogs: AuditLog[],
    orders: OrderRecord[],
    closedPositions: Position[],
    activePositions: Position[]
  ): ResearchRecord[] {
    const recordsMap = new Map<string, ResearchRecord>();

    // 1. Process Audit Logs for signals, evaluations, and rejections
    for (const log of auditLogs) {
      const details = log.details || {};
      const symbol = details.symbol || details.sym || 'UNKNOWN';
      const eventId = log.id || `evt_${log.timestamp}_${Math.random().toString(36).substr(2, 6)}`;

      const relevantTypes: AuditLogType[] = [
        'SIGNAL_GENERATED',
        'SIGNAL_REJECTED',
        'RISK_APPROVED',
        'RISK_REJECTED',
        'ORDER_SUBMITTED',
        'ORDER_ACCEPTED',
        'ORDER_REJECTED',
        'ORDER_FILLED',
        'CANDIDATE_SELECTED',
        'CANDIDATE_REJECTED',
      ];

      if (relevantTypes.includes(log.type)) {
        let status = 'PENDING';
        let rejReason: string | null = null;

        if (
          log.type === 'SIGNAL_REJECTED' ||
          log.type === 'RISK_REJECTED' ||
          log.type === 'CANDIDATE_REJECTED' ||
          log.type === 'ORDER_REJECTED'
        ) {
          status = 'REJECTED';
          rejReason = log.message || details.reason || 'Rejected by Risk or Filters';
          const lower = rejReason.toLowerCase();
          if (lower.includes('balance') || lower.includes('margin')) {
            status = 'REJECTED_BALANCE';
          } else if (lower.includes('max') && lower.includes('position')) {
            status = 'REJECTED_MAX_POSITIONS';
          } else {
            status = 'REJECTED_RISK';
          }
        } else if (
          log.type === 'RISK_APPROVED' ||
          log.type === 'ORDER_SUBMITTED' ||
          log.type === 'ORDER_FILLED' ||
          log.type === 'CANDIDATE_SELECTED'
        ) {
          status = log.type === 'ORDER_FILLED' ? 'EXECUTED' : 'ACCEPTED';
        }

        const record: ResearchRecord = {
          eventId,
          symbol,
          profile: details.profile || details.strategyProfile || 'MOMENTUM',
          side: (details.side || 'BUY').toUpperCase(),
          signalTimestamp: details.signalTimestamp || details.timestamp || log.timestamp,
          decisionTimestamp: log.timestamp,
          entryTimestamp: details.entryTimestamp || null,
          exitTimestamp: null,
          signalScore: details.score || details.signalScore || details.momentumScore || 0,
          rfProbability: details.rfProbability || details.rfProb || 0.5,
          rsi: details.rsi || 50,
          atr: details.atr || 0,
          atrPct: details.atrPct || 0,
          rvol: details.rvol || 1.0,
          volume24hUSDT: details.volume24hUSDT || details.vol24h || 0,
          priceChange24hPct: details.priceChange24hPct || 0,
          openInterest: details.openInterest || details.oi || 0,
          fundingRate: details.fundingRate || 0,
          spreadPct: details.spreadPct || details.spread || 0,
          momentumScore: details.momentumScore || details.score || 0,
          btcRegimePct: details.btcRegimePct || details.btcChange || 0,
          btcRegimeLabel: details.btcRegimeLabel || (details.btcChange < 0 ? 'BEARISH' : 'BULLISH'),
          leverage: typeof details.leverage === 'string' ? parseFloat(details.leverage) || 1 : details.leverage || 1,
          marginMode: details.marginMode || 'isolated',
          sizeUSDT: details.sizeUSDT || details.amountUSDT || 0,
          signalPrice: details.signalPrice || details.price || 0,
          fillPrice: details.fillPrice || null,
          entryPrice: details.entryPrice || null,
          exitPrice: null,
          estimatedSlippagePct: details.estimatedSlippagePct || 0,
          evaluationStatus: status,
          rejectionReason: rejReason,
          realizedPnlPct: null,
          realizedPnlUsdt: null,
          fee: null,
          mae: null,
          mfe: null,
          holdingTimeMinutes: null,
          exitReason: null,
        };

        recordsMap.set(eventId, record);
      }
    }

    // 2. Enrich with Orders data
    for (const ord of orders) {
      const matchedKey = Array.from(recordsMap.keys()).find((k) => {
        const r = recordsMap.get(k)!;
        return r.symbol === ord.symbol && Math.abs(r.signalTimestamp - ord.createdTime) < 10000;
      });

      if (matchedKey) {
        const r = recordsMap.get(matchedKey)!;
        r.fillPrice = ord.fillPrice || r.fillPrice;
        r.entryTimestamp = r.entryTimestamp || ord.createdTime;
        if (ord.status === 'FILLED') {
          r.evaluationStatus = 'EXECUTED';
        } else if (ord.status === 'REJECTED' || ord.status === 'FAILED' || ord.status === 'CANCELLED') {
          r.evaluationStatus = `REJECTED_${ord.status}`;
          r.rejectionReason = ord.rejectionReason || 'Order rejected, failed or canceled';
        }
      } else {
        const eventId = `ord_${ord.id}`;
        recordsMap.set(eventId, {
          eventId,
          symbol: ord.symbol,
          profile: ord.profile || 'MOMENTUM',
          side: ord.side.toUpperCase(),
          signalTimestamp: ord.createdTime,
          decisionTimestamp: ord.createdTime,
          entryTimestamp: ord.updatedTime || ord.createdTime,
          exitTimestamp: null,
          signalScore: ord.signalScore || 0,
          rfProbability: 0.5,
          rsi: 50,
          atr: 0,
          atrPct: 0,
          rvol: 1.0,
          volume24hUSDT: 0,
          priceChange24hPct: 0,
          openInterest: 0,
          fundingRate: 0,
          spreadPct: 0,
          momentumScore: ord.signalScore || 0,
          btcRegimePct: 0,
          btcRegimeLabel: 'NEUTRAL',
          leverage: ord.leverage ? parseFloat(ord.leverage) || 1 : 1,
          marginMode: 'isolated',
          sizeUSDT: ord.sizeUSDT || 0,
          signalPrice: ord.signalPrice || 0,
          fillPrice: ord.fillPrice || null,
          entryPrice: ord.entryPrice || null,
          exitPrice: null,
          estimatedSlippagePct: ord.estimatedSlippagePct || 0,
          evaluationStatus: ord.status === 'FILLED' ? 'EXECUTED' : `ORDER_${ord.status}`,
          rejectionReason: ord.rejectionReason || null,
          realizedPnlPct: ord.realizedPnlPct ?? null,
          realizedPnlUsdt: ord.realizedPnl ?? null,
          fee: ord.cumFee ?? null,
          mae: ord.maePct ?? null,
          mfe: ord.mfePct ?? null,
          holdingTimeMinutes: ord.holdingTimeMinutes ?? null,
          exitReason: ord.exitReasonDetail || null,
        });
      }
    }

    // 3. Enrich with Closed Positions (Raw Outcomes without binarizing WIN/LOSS)
    for (const pos of closedPositions) {
      const matchedKey = Array.from(recordsMap.keys()).find((k) => {
        const r = recordsMap.get(k)!;
        return r.symbol === pos.symbol && Math.abs(r.signalTimestamp - pos.entryTime) < 60000;
      });

      const entryTime = pos.entryTime;
      const exitTime = pos.exitTime || Date.now();
      const holdingMin = pos.holdingTimeMinutes ?? Number(((exitTime - entryTime) / 60000).toFixed(2));

      if (matchedKey) {
        const r = recordsMap.get(matchedKey)!;
        r.evaluationStatus = 'EXECUTED';
        r.entryTimestamp = r.entryTimestamp || entryTime;
        r.exitTimestamp = exitTime;
        r.entryPrice = pos.entryPrice;
        r.exitPrice = pos.exitPrice || pos.currentPrice || null;
        r.realizedPnlPct = pos.pnlPct ?? null;
        r.realizedPnlUsdt = pos.pnl ?? null;
        r.fee = ((pos.entryFee || 0) + (pos.exitFee || 0)) || null;
        r.mae = pos.maePct ?? null;
        r.mfe = pos.mfePct ?? null;
        r.holdingTimeMinutes = holdingMin;
        r.exitReason = pos.exitReasonDetail || 'Closed';
      } else {
        const eventId = `pos_${pos.id}`;
        recordsMap.set(eventId, {
          eventId,
          symbol: pos.symbol,
          profile: pos.profile || 'MOMENTUM',
          side: pos.side.toUpperCase(),
          signalTimestamp: pos.entryTime,
          decisionTimestamp: pos.entryTime,
          entryTimestamp: entryTime,
          exitTimestamp: exitTime,
          signalScore: pos.signalScore || 0,
          rfProbability: 0.5,
          rsi: 50,
          atr: 0,
          atrPct: 0,
          rvol: 1.0,
          volume24hUSDT: 0,
          priceChange24hPct: 0,
          openInterest: 0,
          fundingRate: 0,
          spreadPct: 0,
          momentumScore: pos.signalScore || 0,
          btcRegimePct: 0,
          btcRegimeLabel: 'NEUTRAL',
          leverage: pos.leverage ? parseFloat(pos.leverage) || 1 : 1,
          marginMode: 'isolated',
          sizeUSDT: pos.sizeUSDT || 0,
          signalPrice: pos.signalPrice || pos.entryPrice,
          fillPrice: pos.entryPrice,
          entryPrice: pos.entryPrice,
          exitPrice: pos.exitPrice || pos.currentPrice || null,
          estimatedSlippagePct: pos.estimatedSlippagePct || 0,
          evaluationStatus: 'EXECUTED',
          rejectionReason: null,
          realizedPnlPct: pos.pnlPct ?? null,
          realizedPnlUsdt: pos.pnl ?? null,
          fee: ((pos.entryFee || 0) + (pos.exitFee || 0)) || null,
          mae: pos.maePct ?? null,
          mfe: pos.mfePct ?? null,
          holdingTimeMinutes: holdingMin,
          exitReason: pos.exitReasonDetail || 'Closed',
        });
      }
    }

    return Array.from(recordsMap.values());
  }

  public static convertToCSV(records: ResearchRecord[]): string {
    if (records.length === 0) return '';
    const headers = Object.keys(records[0]);
    const csvRows = [headers.join(',')];

    for (const record of records) {
      const values = headers.map((h) => {
        const val = (record as any)[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`;
        return val;
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }
}
