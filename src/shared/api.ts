import { Capacitor } from '@capacitor/core';

const API_BASE_URL_KEY = 'tb5_api_base_url';

function isPrivateIPv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Introdu o adresă completă, de exemplu http://192.168.1.25:3000.');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Adresa trebuie să conțină doar protocolul, IP-ul și portul serverului.');
  }

  if (
    url.protocol === 'http:' &&
    Capacitor.isNativePlatform() &&
    url.hostname !== 'localhost' &&
    !isPrivateIPv4(url.hostname)
  ) {
    throw new Error('Pe Android, HTTP este permis doar către o adresă IPv4 privată din rețeaua locală.');
  }

  return url.origin;
}

export function getConfiguredApiBaseUrl(): string {
  const value = localStorage.getItem(API_BASE_URL_KEY);
  return value ? normalizeApiBaseUrl(value) : '';
}

export function saveApiBaseUrl(value: string): string {
  const normalizedUrl = normalizeApiBaseUrl(value);
  localStorage.setItem(API_BASE_URL_KEY, normalizedUrl);
  return normalizedUrl;
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    const baseUrl = getConfiguredApiBaseUrl();
    return globalThis.fetch(`${baseUrl}${input}`, init);
  }

  return globalThis.fetch(input, init);
}
