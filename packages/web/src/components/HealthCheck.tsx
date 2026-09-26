import { useEffect, useState } from 'react';

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  services: {
    database: 'connected' | 'disconnected' | 'error';
    discord: 'connected' | 'disconnected' | 'error';
  };
}

type FetchState = 'loading' | 'success' | 'error';

/**
 * Health check dashboard component.
 *
 * Polls GET /api/health every 10 seconds and displays
 * the status of each backend service.
 */
export function HealthCheck() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: HealthResponse = await response.json();
        setHealth(data);
        setFetchState('success');
        setErrorMessage('');
      } catch (err) {
        setFetchState('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to reach backend');
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="health-card">
      <h2 className="health-card-title">
        <span>⚡</span> System Status
      </h2>

      {fetchState === 'error' && (
        <div className="health-error">
          Backend unreachable — {errorMessage}
        </div>
      )}

      {fetchState === 'loading' && (
        <div className="health-services">
          <ServiceRow name="Database" status="loading" />
          <ServiceRow name="Discord" status="loading" />
        </div>
      )}

      {fetchState === 'success' && health && (
        <>
          <div className="health-services">
            <ServiceRow name="Database" status={health.services.database} />
            <ServiceRow name="Discord" status={health.services.discord} />
          </div>

          <div className="health-overall">
            <span className="health-overall-label">Overall</span>
            <span className={`health-overall-status ${health.status}`}>
              {health.status.toUpperCase()}
            </span>
          </div>

          <div className="health-timestamp">
            Last checked: {new Date(health.timestamp).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}

function ServiceRow({ name, status }: { name: string; status: string }) {
  return (
    <div className="health-service">
      <span className="health-service-name">{name}</span>
      <span className={`health-status-badge ${status}`}>
        <span className={`status-dot ${status}`} />
        {status}
      </span>
    </div>
  );
}
