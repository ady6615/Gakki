import { HealthCheck } from './components/HealthCheck';
import { PlaybackStatus } from './components/PlaybackStatus';
import { PlaylistSection } from './components/PlaylistSection';
import { SmartDJSection } from './components/SmartDJSection';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">
          <span className="title-icon">🎵</span>
          Gakki
        </h1>
        <p className="app-subtitle">Modular Music Platform</p>
      </header>

      <main className="app-main">
        <PlaybackStatus />
        <SmartDJSection />
        <PlaylistSection />
        <HealthCheck />
      </main>

      <footer className="app-footer">
        <p>Gakki v0.7.0 — Phase 7 Audio Analysis, Smart Recommendations & Dynamic DJ</p>
      </footer>
    </div>
  );
}

export default App;
