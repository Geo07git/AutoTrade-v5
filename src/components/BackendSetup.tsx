import React, { useState } from 'react';
import { normalizeApiBaseUrl, saveApiBaseUrl } from '../shared/api';

interface BackendSetupProps {
  initialUrl: string;
  required: boolean;
  onClose: () => void;
  onConnected: (url: string) => void;
}

export const BackendSetup: React.FC<BackendSetupProps> = ({
  initialUrl,
  required,
  onClose,
  onConnected,
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const connect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsConnecting(true);

    try {
      const baseUrl = normalizeApiBaseUrl(url);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try {
        response = await globalThis.fetch(`${baseUrl}/api/health`, {
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Serverul a răspuns cu HTTP ${response.status}.`);
      }

      const health: unknown = await response.json();
      if (
        typeof health !== 'object' ||
        health === null ||
        !('status' in health) ||
        health.status !== 'ok'
      ) {
        throw new Error('Adresa nu pare să indice serverul TradeBot.');
      }

      const savedUrl = saveApiBaseUrl(baseUrl);
      onConnected(savedUrl);
    } catch (connectionError) {
      const message =
        connectionError instanceof Error ? connectionError.message : 'Eroare necunoscută.';
      setError(
        message === 'Failed to fetch' || message.includes('aborted')
          ? 'Server inaccesibil. Verifică IP-ul, portul 3000, conexiunea Wi-Fi și permisiunea din firewall-ul Windows.'
          : message
      );
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="min-h-full w-full bg-black p-4 text-amber-400 sm:p-8">
      <div className="mx-auto mt-8 max-w-xl space-y-5 rounded-lg border border-amber-500/40 bg-zinc-950 p-5 shadow-xl sm:mt-16 sm:p-7">
        <div className="space-y-2">
          <div className="text-xs font-bold tracking-[0.2em] text-amber-500">
            TRADEBOT • CONEXIUNE LOCALĂ
          </div>
          <h1 className="text-2xl font-black text-white">Conectează serverul de pe PC</h1>
          <p className="text-sm leading-6 text-zinc-300">
            APK-ul conține interfața. Serverul de tranzacționare rulează pe PC; telefonul și PC-ul
            trebuie să fie conectate la aceeași rețea Wi-Fi.
          </p>
        </div>

        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-zinc-300">
          <li>Pornește TradeBot Pro Terminal pe PC și lasă-l deschis.</li>
          <li>
            Pe PC, rulează <code className="rounded bg-black px-1.5 py-0.5 text-amber-300">ipconfig</code>{' '}
            și găsește adresa IPv4 a rețelei Wi-Fi.
          </li>
          <li>
            Introdu <code className="rounded bg-black px-1.5 py-0.5 text-amber-300">http://IP-UL-PC-ULUI:3000</code>{' '}
            (de exemplu <code className="rounded bg-black px-1.5 py-0.5 text-amber-300">http://192.168.1.25:3000</code>).
          </li>
          <li>Dacă Windows Firewall întreabă, permite accesul doar pentru rețele private.</li>
        </ol>

        <form onSubmit={connect} className="space-y-3">
          <label htmlFor="backend-url" className="block text-sm font-bold text-amber-300">
            Adresa serverului local
          </label>
          <input
            id="backend-url"
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://192.168.1.25:3000"
            className="w-full rounded border border-zinc-700 bg-black px-3 py-3 text-base text-white outline-none focus:border-amber-400"
          />
          {error && (
            <div role="alert" className="rounded border border-rose-500/40 bg-rose-950/30 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isConnecting}
              className="rounded bg-amber-500 px-4 py-3 font-bold text-black disabled:cursor-wait disabled:opacity-60"
            >
              {isConnecting ? 'Se testează conexiunea…' : 'Testează și conectează'}
            </button>
            {!required && (
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-zinc-700 px-4 py-3 font-bold text-zinc-300"
              >
                Anulează
              </button>
            )}
          </div>
        </form>

        <p className="border-t border-zinc-800 pt-4 text-xs leading-5 text-amber-200/80">
          Conexiunea HTTP locală nu este criptată. Folosește doar o rețea Wi-Fi privată și de
          încredere; nu configura un IP public și nu introduce chei API când telefonul este pe
          rețele publice.
        </p>
      </div>
    </div>
  );
};
