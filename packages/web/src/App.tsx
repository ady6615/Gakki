import { HealthCheck } from './components/HealthCheck';
import { PlaybackStatus } from './components/PlaybackStatus';

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
        <HealthCheck />
      </main>

      <footer className="app-footer">
        <p>Gakki v0.2.0 — Phase 2 Voice Playback</p>
      </footer>
    </div>
  );
}

export default App;
