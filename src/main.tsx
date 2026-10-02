import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initCapacitorMockBackend } from './services/capacitorMockBackend';

// Only initialize mock backend if running strictly inside native mobile Capacitor WebView (APK)
if (typeof window !== 'undefined' && Boolean((window as any).Capacitor?.isNativePlatform?.())) {
  initCapacitorMockBackend();
} else if (typeof window !== 'undefined') {
  // Purge any residual mock keys so real backend is always used
  try {
    localStorage.removeItem('tb5_mock_status');
    localStorage.removeItem('tb5_mock_logs');
    localStorage.removeItem('tb5_mock_orders');
    localStorage.removeItem('tb5_mock_config');
    localStorage.removeItem('tb5_mock_scanner');
  } catch (e) {}
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
