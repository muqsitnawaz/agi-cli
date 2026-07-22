import { DatabaseZap, Server, ShieldCheck } from 'lucide-react';

export type ServerStatus = 'online' | 'warning' | 'idle';

export interface DebugServer {
  id: string;
  name: string;
  detail: string;
  status: ServerStatus;
}

export const DEBUG_SERVERS: DebugServer[] = [
  { id: 'mcp', name: 'MCP Bridge', detail: 'JSON-RPC stream', status: 'online' },
  { id: 'oauth', name: 'OAuth Broker', detail: '3 leases watched', status: 'warning' },
  { id: 'resources', name: 'Resources', detail: 'profiles composed', status: 'idle' },
];

export function ServersSidebar({ servers = DEBUG_SERVERS, activeId = 'mcp' }: {
  servers?: DebugServer[];
  activeId?: string;
}) {
  return (
    <aside className="dbg-sidebar" aria-label="Debug servers">
      <div className="dbg-brand">
        <div className="dbg-brand-mark" aria-hidden="true">
          <ShieldCheck size={18} strokeWidth={1.8} />
        </div>
        <div className="dbg-brand-copy">
          <div className="dbg-kicker">Debug Console</div>
          <div className="dbg-title">agents-dbg</div>
        </div>
      </div>

      <section className="dbg-sidebar-section">
        <div className="dbg-sidebar-label">Servers</div>
        {servers.map(server => (
          <button
            key={server.id}
            className="dbg-server-pill"
            data-active={server.id === activeId}
            type="button"
          >
            <span className="dbg-server-icon" aria-hidden="true">
              {server.id === 'resources' ? <DatabaseZap size={15} /> : <Server size={15} />}
            </span>
            <span className="dbg-server-copy">
              <span className="dbg-server-name">{server.name}</span>
              <span className="dbg-server-meta">{server.detail}</span>
            </span>
            <span className="dbg-status-dot" data-state={server.status} aria-label={server.status} />
          </button>
        ))}
      </section>

      <p className="dbg-sidebar-note">
        Live traces stay quiet until a server needs attention.
      </p>
    </aside>
  );
}
