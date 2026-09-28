import { HealthCheck } from './components/HealthCheck';
import { PlaybackStatus } from './components/PlaybackStatus';
import { PlaylistSection } from './components/PlaylistSection';
import { SmartDJSection } from './components/SmartDJSection';
import { DJTransitionSection } from './components/DJTransitionSection';
import { StemMixingSection } from './components/StemMixingSection';

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
        <StemMixingSection />
        <DJTransitionSection />
        <SmartDJSection />
        <PlaylistSection />
        <HealthCheck />
      </main>

      <footer className="app-footer">
        <p>Gakki v0.9.0 — Phase 9 Stem Separation, Vocal Clash Prevention & Layered DJ Mixing</p>
      </footer>
    </div>
  );
}

export default App;
