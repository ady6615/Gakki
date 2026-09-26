import { HealthCheck } from './components/HealthCheck';

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
        <HealthCheck />
      </main>

      <footer className="app-footer">
        <p>Gakki v0.1.0 — Phase 1</p>
      </footer>
    </div>
  );
}

export default App;
