/**
 * High-precision formatting utilities for cryptocurrency prices, notional sizes, and exports.
 * Eliminates truncation bugs on sub-$0.01 tokens (e.g. MEW, IOST, BILL, PEPE, SHIB).
 */

/**
 * Calculates decimal precision from instrument tick size (e.g. 0.00001 -> 5 decimals, 0.00000001 -> 8 decimals)
 */
export function getDecimalsFromTickSize(tickSize: number): number {
  if (!tickSize || tickSize >= 1) return 2;
  const str = tickSize.toString();
  if (str.includes('e-')) {
    const exp = parseInt(str.split('e-')[1], 10);
    return Math.min(12, Math.max(2, exp));
  }
  const parts = str.split('.');
  return parts[1] ? Math.min(12, Math.max(2, parts[1].length)) : 2;
}

/**
 * Formats a cryptocurrency price according to its scale, tick magnitude, and optional instrument filter:
 * - >= $1,000: 2 decimals with commas (e.g. "$65,420.50")
 * - $1 to $1,000: 2 to 4 decimals (e.g. "$1.721", "$18.45")
 * - $0.01 to $1: 4 to 5 decimals (e.g. "$0.04149", "$0.13466")
 * - $0.0001 to $0.01: 6 decimals (e.g. "$0.001903", "$0.000477")
 * - < $0.0001: 8+ decimals (e.g. "$0.00001234")
 */
export function formatPrice(
  price: number | undefined | null,
  options?: { prefix?: string; minDecimals?: number; tickSize?: number }
): string {
  if (price === undefined || price === null || isNaN(price)) return '--';
  const prefix = options?.prefix ?? '';
  const abs = Math.abs(price);

  if (price === 0) return `${prefix}0.00`;

  let decimals = 2;
  if (options?.tickSize && options.tickSize > 0 && options.tickSize < 1) {
    decimals = getDecimalsFromTickSize(options.tickSize);
  } else if (abs >= 1000) {
    return `${prefix}${price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } else if (abs >= 1) {
    decimals = Math.max(options?.minDecimals ?? 2, abs >= 20 ? 2 : 4);
  } else if (abs >= 0.01) {
    decimals = Math.max(options?.minDecimals ?? 4, 4);
  } else if (abs >= 0.0001) {
    decimals = Math.max(options?.minDecimals ?? 6, 6);
  } else {
    decimals = Math.max(options?.minDecimals ?? 8, 8);
  }

  if (options?.minDecimals && decimals < options.minDecimals) {
    decimals = options.minDecimals;
  }

  return `${prefix}${price.toFixed(decimals)}`;
}

/**
 * Returns exact high-precision string representation of a price (at least 8-10 decimals for sub-$1 prices)
 * for CSV exports, Blotter reconciliation, and audit logs.
 */
export function formatExactPriceForExport(price: number | undefined | null): string {
  if (price === undefined || price === null || isNaN(price)) return '';
  const abs = Math.abs(price);
  if (abs === 0) return '0.00';
  if (abs >= 1000) return price.toFixed(4);
  if (abs >= 10) return price.toFixed(6);
  if (abs >= 0.01) return price.toFixed(8);
  // Sub-$0.01 tokens (e.g. MEW, IOST, BILL, PEPE) receive 10 decimals for exact verifiable reconciliation
  return price.toFixed(10);
}

/**
 * Standard Romanian Local Time (Europe/Bucharest, 24h format HH:MM:SS)
 */
export function formatTimeLocal(dateVal: number | string | Date, timeZone: string = 'Europe/Bucharest'): string {
  if (!dateVal) return '--:--:--';
  const d = typeof dateVal === 'number' || typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('ro-RO', { timeZone, hour12: false });
}

/**
 * Standard Romanian Local Date & Time (Europe/Bucharest, 24h format DD.MM.YYYY, HH:MM:SS)
 */
export function formatDateTimeLocal(dateVal: number | string | Date, timeZone: string = 'Europe/Bucharest'): string {
  if (!dateVal) return '--/--/---- --:--';
  const d = typeof dateVal === 'number' || typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
  if (isNaN(d.getTime())) return '--/--/---- --:--';
  return d.toLocaleString('ro-RO', { timeZone, hour12: false });
}

