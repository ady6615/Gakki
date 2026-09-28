import { useState, useEffect } from 'react';

export interface LibrarySearchResult {
  tracks: Array<{
    id: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
    coverArt?: string;
  }>;
  artists: Array<{
    name: string;
    trackCount: number;
    coverArt?: string;
  }>;
  albums: Array<{
    name: string;
    artist?: string;
    trackCount: number;
    coverArt?: string;
  }>;
  playlists: Array<{
    id: string;
    name: string;
    trackCount: number;
    description?: string;
  }>;
}

export interface TrackDetails {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverArt?: string;
  bpm?: number;
  key?: string;
  energy?: number;
  playCount: number;
  completionRate?: number;
  sources: string[];
}

export interface SimilarTrackItem {
  trackId: string;
  name: string;
  artist?: string;
  similarityScore: number;
  bpm?: number;
  key?: string;
}

interface LibrarySectionProps {
  guildId: string;
  onEnqueueTrack?: (sourceUrlOrName: string) => void;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function LibrarySection({ guildId, onEnqueueTrack }: LibrarySectionProps) {
  // Tabs: 'search' | 'tracks' | 'artists' | 'albums' | 'favorites' | 'history'
  const [activeTab, setActiveTab] = useState<'search' | 'tracks' | 'artists' | 'albums' | 'favorites' | 'history'>('tracks');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LibrarySearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  // Browse lists
  const [tracks, setTracks] = useState<any[]>([]);
  const [artists, setArtists] = useState<any[]>([]);
  const [albums, setAlbums] = useState<any[]>([]);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [page, setPage] = useState(0);
  const limit = 20;

  // Track Details Drawer / Modal
  const [selectedTrackDetails, setSelectedTrackDetails] = useState<TrackDetails | null>(null);
  const [similarTracks, setSimilarTracks] = useState<SimilarTrackItem[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/library/search?q=${encodeURIComponent(searchQuery.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data);
          setActiveTab('search');
        }
      } catch {
        // ignore
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Load section content when tab changes
  useEffect(() => {
    if (activeTab === 'tracks') {
      fetch(`/api/library/tracks?limit=${limit}&offset=${page * limit}`)
        .then((res) => res.json())
        .then((data) => setTracks(data.tracks || []))
        .catch(() => {});
    } else if (activeTab === 'artists') {
      fetch(`/api/library/artists?limit=${limit}&offset=${page * limit}`)
        .then((res) => res.json())
        .then((data) => setArtists(data.artists || []))
        .catch(() => {});
    } else if (activeTab === 'albums') {
      fetch(`/api/library/albums?limit=${limit}&offset=${page * limit}`)
        .then((res) => res.json())
        .then((data) => setAlbums(data.albums || []))
        .catch(() => {});
    } else if (activeTab === 'favorites') {
      fetch(`/api/favorites`)
        .then((res) => res.json())
        .then((data) => setFavorites(data.favorites || []))
        .catch(() => {});
    } else if (activeTab === 'history') {
      fetch(`/api/history/recent?guildId=${guildId || 'web-dashboard'}`)
        .then((res) => res.json())
        .then((data) => setHistory(data || []))
        .catch(() => {});
    }
  }, [activeTab, page, guildId]);

  // Open Track Details (Requirement 13 & 14)
  const openTrackDetails = async (trackId: string) => {
    setDetailsLoading(true);
    try {
      const res = await fetch(`/api/library/tracks/${trackId}`);
      if (res.ok) {
        const details: TrackDetails = await res.json();
        setSelectedTrackDetails(details);

        // Fetch Similar Tracks (Phase 7 similarity reuse)
        fetch(`/api/recommendations/similar/${trackId}`)
          .then((r) => (r.ok ? r.json() : []))
          .then((sim) => setSimilarTracks(sim))
          .catch(() => setSimilarTracks([]));
      }
    } catch {
      // ignore
    } finally {
      setDetailsLoading(false);
    }
  };

  const closeTrackDetails = () => {
    setSelectedTrackDetails(null);
    setSimilarTracks([]);
  };

  const handleQueueTrack = (input: string) => {
    if (onEnqueueTrack) {
      onEnqueueTrack(input);
    } else if (guildId) {
      // fallback direct queue
      fetch(`/api/queue/${guildId}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [input], addedBy: 'Web UI' }),
      }).catch(() => {});
    }
  };

  return (
    <section className="library-section glass-panel" aria-label="Music Library Browsing">
      {/* Search Input Bar */}
      <div className="library-search-bar">
        <span className="search-icon">🔍</span>
        <input
          type="search"
          placeholder="Search tracks, artists, albums, playlists..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="library-search-input"
          aria-label="Library search query"
        />
        {searchLoading && <span className="search-spinner">🔄</span>}
      </div>

      {/* Library Navigation Tabs */}
      <div className="library-tabs" role="tablist">
        {searchResults && (
          <button
            className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
            role="tab"
            aria-selected={activeTab === 'search'}
          >
            🔎 Results
          </button>
        )}
        <button
          className={`tab-btn ${activeTab === 'tracks' ? 'active' : ''}`}
          onClick={() => { setActiveTab('tracks'); setPage(0); }}
          role="tab"
          aria-selected={activeTab === 'tracks'}
        >
          🎵 Tracks
        </button>
        <button
          className={`tab-btn ${activeTab === 'artists' ? 'active' : ''}`}
          onClick={() => { setActiveTab('artists'); setPage(0); }}
          role="tab"
          aria-selected={activeTab === 'artists'}
        >
          👤 Artists
        </button>
        <button
          className={`tab-btn ${activeTab === 'albums' ? 'active' : ''}`}
          onClick={() => { setActiveTab('albums'); setPage(0); }}
          role="tab"
          aria-selected={activeTab === 'albums'}
        >
          💿 Albums
        </button>
        <button
          className={`tab-btn ${activeTab === 'favorites' ? 'active' : ''}`}
          onClick={() => setActiveTab('favorites')}
          role="tab"
          aria-selected={activeTab === 'favorites'}
        >
          ❤️ Favorites
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
          role="tab"
          aria-selected={activeTab === 'history'}
        >
          🕒 Recently Played
        </button>
      </div>

      {/* Tab Contents */}
      <div className="library-tab-content">
        {/* 1. Unified Search View (Requirement 11) */}
        {activeTab === 'search' && searchResults && (
          <div className="search-results-container">
            {/* Tracks */}
            {searchResults.tracks.length > 0 && (
              <div className="search-category-group">
                <h4 className="category-title">TRACKS</h4>
                <div className="search-items-list">
                  {searchResults.tracks.map((t) => (
                    <div key={t.id} className="search-item-row">
                      <span className="item-icon">🎵</span>
                      <div className="item-text">
                        <span className="item-title">{t.title}</span>
                        <span className="item-subtitle">{t.artist || 'Unknown'} • {formatDuration(t.duration)}</span>
                      </div>
                      <div className="item-actions">
                        <button
                          className="item-btn"
                          onClick={() => openTrackDetails(t.id)}
                          aria-label={`Details for ${t.title}`}
                          title="View analysis details"
                        >
                          ℹ️
                        </button>
                        <button
                          className="item-btn play-btn"
                          onClick={() => handleQueueTrack(t.title)}
                          aria-label={`Queue ${t.title}`}
                          title="Add to queue"
                        >
                          ➕ Queue
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Artists */}
            {searchResults.artists.length > 0 && (
              <div className="search-category-group">
                <h4 className="category-title">ARTISTS</h4>
                <div className="search-cards-grid">
                  {searchResults.artists.map((a, i) => (
                    <div key={i} className="artist-card">
                      <div className="card-avatar">👤</div>
                      <span className="card-name">{a.name}</span>
                      <span className="card-meta">{a.trackCount} {a.trackCount === 1 ? 'track' : 'tracks'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Albums */}
            {searchResults.albums.length > 0 && (
              <div className="search-category-group">
                <h4 className="category-title">ALBUMS</h4>
                <div className="search-cards-grid">
                  {searchResults.albums.map((al, i) => (
                    <div key={i} className="album-card">
                      <div className="card-artwork">💿</div>
                      <span className="card-name">{al.name}</span>
                      <span className="card-meta">{al.artist || 'Various'} • {al.trackCount} tracks</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Playlists */}
            {searchResults.playlists.length > 0 && (
              <div className="search-category-group">
                <h4 className="category-title">PLAYLISTS</h4>
                <div className="search-cards-grid">
                  {searchResults.playlists.map((p) => (
                    <div key={p.id} className="playlist-card">
                      <div className="card-artwork">📜</div>
                      <span className="card-name">{p.name}</span>
                      <span className="card-meta">{p.trackCount} tracks</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {searchResults.tracks.length === 0 &&
              searchResults.artists.length === 0 &&
              searchResults.albums.length === 0 &&
              searchResults.playlists.length === 0 && (
                <div className="empty-results-msg">No results matching "{searchQuery}"</div>
              )}
          </div>
        )}

        {/* 2. Tracks View (Paginated) */}
        {activeTab === 'tracks' && (
          <div className="tracks-browse-view">
            <div className="items-list">
              {tracks.length === 0 ? (
                <div className="empty-results-msg">No tracks in library yet.</div>
              ) : (
                tracks.map((t, index) => (
                  <div key={t.id || index} className="browse-track-row">
                    <span className="row-index">{page * limit + index + 1}</span>
                    <div className="row-info">
                      <span className="row-title">{t.title}</span>
                      <span className="row-artist">{t.artist || 'Unknown'} {t.album ? `• ${t.album}` : ''}</span>
                    </div>
                    <span className="row-duration">{formatDuration(t.duration)}</span>
                    <div className="row-actions">
                      <button
                        className="item-btn"
                        onClick={() => openTrackDetails(t.id)}
                        aria-label={`View details for ${t.title}`}
                        title="View details & audio features"
                      >
                        ℹ️
                      </button>
                      <button
                        className="item-btn play-btn"
                        onClick={() => handleQueueTrack(t.title)}
                        aria-label={`Queue ${t.title}`}
                        title="Add to queue"
                      >
                        ➕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Pagination Controls */}
            <div className="pagination-bar">
              <button
                className="page-btn"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ◀ Previous
              </button>
              <span className="page-indicator">Page {page + 1}</span>
              <button
                className="page-btn"
                disabled={tracks.length < limit}
                onClick={() => setPage((p) => p + 1)}
              >
                Next ▶
              </button>
            </div>
          </div>
        )}

        {/* 3. Artists View */}
        {activeTab === 'artists' && (
          <div className="artists-grid">
            {artists.length === 0 ? (
              <div className="empty-results-msg">No artists indexed.</div>
            ) : (
              artists.map((a, i) => (
                <div key={i} className="artist-card-item glass-card">
                  <div className="artist-avatar">👤</div>
                  <h4 className="artist-name">{a.name}</h4>
                  <span className="artist-track-count">{a.trackCount} tracks</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* 4. Albums View */}
        {activeTab === 'albums' && (
          <div className="albums-grid">
            {albums.length === 0 ? (
              <div className="empty-results-msg">No albums indexed.</div>
            ) : (
              albums.map((al, i) => (
                <div key={i} className="album-card-item glass-card">
                  <div className="album-cover-placeholder">💿</div>
                  <h4 className="album-title">{al.name}</h4>
                  <span className="album-artist-name">{al.artist || 'Various'}</span>
                  <span className="album-count">{al.trackCount} tracks</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* 5. Favorites View (Requirement 6) */}
        {activeTab === 'favorites' && (
          <div className="favorites-view">
            {favorites.length === 0 ? (
              <div className="empty-results-msg">
                <span>No favorites yet.</span>
                <small>Use the ❤️ button in Now Playing or <code>/favorite</code> in Discord</small>
              </div>
            ) : (
              <div className="items-list">
                {favorites.map((fav, i) => (
                  <div key={fav.trackId || i} className="browse-track-row favorite-row">
                    <span className="favorite-icon">❤️</span>
                    <div className="row-info">
                      <span className="row-title">{fav.title}</span>
                      <span className="row-artist">{fav.artist || 'Unknown Artist'}</span>
                    </div>
                    <span className="row-duration">{formatDuration(fav.duration)}</span>
                    <div className="row-actions">
                      <button
                        className="item-btn play-btn"
                        onClick={() => handleQueueTrack(fav.title)}
                        aria-label={`Queue ${fav.title}`}
                      >
                        ➕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 6. History View */}
        {activeTab === 'history' && (
          <div className="history-view">
            {history.length === 0 ? (
              <div className="empty-results-msg">No recently played tracks recorded.</div>
            ) : (
              <div className="items-list">
                {history.map((hist, i) => (
                  <div key={i} className="browse-track-row">
                    <span className="row-index">🕒</span>
                    <div className="row-info">
                      <span className="row-title">{hist.title}</span>
                      <span className="row-artist">{hist.artist || 'Unknown'}</span>
                    </div>
                    <span className="row-duration">
                      {hist.durationListened ? `${Math.round(hist.durationListened)}s played` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Track Details Modal / Panel (Requirement 13 & 14) */}
      {selectedTrackDetails && (
        <div className="modal-backdrop" onClick={closeTrackDetails} role="dialog" aria-modal="true">
          <div className="track-details-modal glass-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🎵 Track Details {detailsLoading && <span style={{ fontSize: '0.75rem', color: '#c084fc' }}>🔄</span>}</h3>
              <button className="close-btn" onClick={closeTrackDetails} aria-label="Close modal">
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="details-main-info">
                <div className="details-cover-box">
                  {selectedTrackDetails.coverArt ? (
                    <img src={selectedTrackDetails.coverArt} alt="" className="details-cover-img" />
                  ) : (
                    <span className="details-placeholder-disc">💿</span>
                  )}
                </div>
                <div className="details-text-block">
                  <h4 className="details-track-name">{selectedTrackDetails.title}</h4>
                  <p className="details-artist-name">{selectedTrackDetails.artist || 'Unknown Artist'}</p>
                  {selectedTrackDetails.album && (
                    <p className="details-album-name">💿 {selectedTrackDetails.album}</p>
                  )}
                  <p className="details-duration">Duration: {formatDuration(selectedTrackDetails.duration)}</p>
                </div>
              </div>

              {/* Audio Analysis Feature Badges (Requirement 13) */}
              <div className="analysis-features-grid">
                <div className="feature-stat-box">
                  <span className="stat-label">BPM</span>
                  <span className="stat-value">{selectedTrackDetails.bpm ? Math.round(selectedTrackDetails.bpm) : 'N/A'}</span>
                </div>
                <div className="feature-stat-box">
                  <span className="stat-label">Key</span>
                  <span className="stat-value">{selectedTrackDetails.key || 'N/A'}</span>
                </div>
                <div className="feature-stat-box">
                  <span className="stat-label">Energy</span>
                  <span className="stat-value">
                    {selectedTrackDetails.energy != null
                      ? `${Math.round(selectedTrackDetails.energy * 100)}%`
                      : 'N/A'}
                  </span>
                </div>
                <div className="feature-stat-box">
                  <span className="stat-label">Plays</span>
                  <span className="stat-value">{selectedTrackDetails.playCount || 0}</span>
                </div>
              </div>

              {/* Sources */}
              {selectedTrackDetails.sources && selectedTrackDetails.sources.length > 0 && (
                <div className="track-sources-row">
                  <span className="sources-label">Sources:</span>
                  {selectedTrackDetails.sources.map((s, i) => (
                    <span key={i} className={`source-pill source-${s}`}>{s}</span>
                  ))}
                </div>
              )}

              {/* Similar Tracks (Requirement 14) */}
              <div className="similar-tracks-section">
                <h5 className="similar-title">✨ Similar Tracks</h5>
                {similarTracks.length === 0 ? (
                  <p className="no-similar-text">No similar analyzed tracks found in library.</p>
                ) : (
                  <div className="similar-list">
                    {similarTracks.map((sim) => (
                      <div key={sim.trackId} className="similar-item-row">
                        <div className="similar-info">
                          <span className="sim-name">{sim.name}</span>
                          <span className="sim-meta">
                            {sim.artist ? `${sim.artist} • ` : ''}
                            {sim.similarityScore ? `${Math.round(sim.similarityScore * 100)}% Match` : ''}
                          </span>
                        </div>
                        <button
                          className="item-btn play-btn"
                          onClick={() => handleQueueTrack(sim.name)}
                          aria-label={`Queue ${sim.name}`}
                          title="Queue track"
                        >
                          ➕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="modal-action-btn primary"
                onClick={() => {
                  handleQueueTrack(selectedTrackDetails.title);
                  closeTrackDetails();
                }}
              >
                Queue This Track
              </button>
              <button className="modal-action-btn" onClick={closeTrackDetails}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
