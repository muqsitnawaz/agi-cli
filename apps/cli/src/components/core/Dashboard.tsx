import { Activity, Bell, Braces, Gauge, Search, Settings2 } from 'lucide-react';
import { ServersSidebar } from './ServersSidebar.js';

const LOG_ROWS = [
  { time: '12:08:14', type: 'rpc', message: 'resources/list completed for codex profile' },
  { time: '12:08:18', type: 'auth', message: 'OAuth refresh lease entered grace window' },
  { time: '12:08:23', type: 'mcp', message: 'server capability snapshot reconciled' },
];

export function Dashboard() {
  return (
    <div className="dbg-shell">
      <ServersSidebar />
      <main className="dbg-main">
        <header className="dbg-topbar">
          <div>
            <div className="dbg-kicker">Runtime Console</div>
            <h1 className="dbg-topbar-title">Server traces</h1>
          </div>
          <div className="dbg-topbar-actions" aria-label="Dashboard actions">
            <button className="dbg-icon-button" type="button" aria-label="Search logs">
              <Search size={16} />
            </button>
            <button className="dbg-icon-button" type="button" aria-label="Notification rules">
              <Bell size={16} />
            </button>
            <button className="dbg-icon-button" type="button" aria-label="Debug settings">
              <Settings2 size={16} />
            </button>
          </div>
        </header>

        <section className="dbg-grid" aria-label="Debug dashboard">
          <article className="dbg-panel">
            <div className="dbg-panel-header">
              <Braces className="dbg-panel-icon" size={17} />
              <div className="dbg-panel-title">JSON-RPC and OAuth log stream</div>
            </div>
            <div className="dbg-log-list">
              {LOG_ROWS.map(row => (
                <div className="dbg-log-row" key={`${row.time}-${row.type}`}>
                  <div className="dbg-log-time">{row.time}</div>
                  <div className="dbg-log-message">{row.message}</div>
                  <div className="dbg-log-type">{row.type}</div>
                </div>
              ))}
            </div>
          </article>

          <aside className="dbg-panel">
            <div className="dbg-panel-header">
              <Activity className="dbg-panel-icon" size={17} />
              <div className="dbg-panel-title">Health</div>
            </div>
            <div className="dbg-metrics">
              <div className="dbg-metric">
                <span className="dbg-metric-label">Server uptime</span>
                <span className="dbg-metric-value">99.98%</span>
              </div>
              <div className="dbg-metric">
                <span className="dbg-metric-label">P95 latency</span>
                <span className="dbg-metric-value">41 ms</span>
              </div>
              <div className="dbg-metric">
                <span className="dbg-metric-label">Lease warnings</span>
                <span className="dbg-metric-value">3</span>
              </div>
            </div>
          </aside>

          <aside className="dbg-panel">
            <div className="dbg-panel-header">
              <Gauge className="dbg-panel-icon" size={17} />
              <div className="dbg-panel-title">Throughput</div>
            </div>
            <div className="dbg-metrics">
              <div className="dbg-metric">
                <span className="dbg-metric-label">Events captured</span>
                <span className="dbg-metric-value">1,248</span>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
