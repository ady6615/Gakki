import { HealthCheck } from './components/HealthCheck';
import { PlaybackStatus } from './components/PlaybackStatus';
import { PlaylistSection } from './components/PlaylistSection';

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
        <PlaylistSection />
        <HealthCheck />
      </main>

      <footer className="app-footer">
        <p>Gakki v0.6.0 — Phase 6 Play History, Persistent Playlists & Session Analytics</p>
      </footer>
    </div>
  );
}

export default App;
