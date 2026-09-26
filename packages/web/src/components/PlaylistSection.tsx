import React, { useEffect, useState } from 'react';

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string | null;
  guildId: string | null;
  visibility: 'public' | 'private' | 'guild';
  trackCount: number;
}

export interface PlaylistTrackItem {
  id?: string;
  playlistId: string;
  trackId: string;
  position: number;
  addedBy: string | null;
  track?: {
    id: string;
    title: string;
    artist: string | null;
    album: string | null;
    duration: number | null;
    coverArt: string | null;
  };
  source?: {
    provider: string;
    sourceType: string;
    sourceUrl: string;
  } | null;
}

export interface RecentTrackItem {
  trackId: string;
  title: string;
  artist: string | null;
  lastPlayedAt: string;
  endReason: string | null;
  durationListened: number;
}

const API_BASE = 'http://localhost:3000/api';

function formatDuration(seconds?: number | null): string {
  if (seconds == null || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function PlaylistSection() {
  const [userPlaylists, setUserPlaylists] = useState<PlaylistSummary[]>([]);
  const [guildPlaylists, setGuildPlaylists] = useState<PlaylistSummary[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSummary | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<PlaylistTrackItem[]>([]);
  const [recentTracks, setRecentTracks] = useState<RecentTrackItem[]>([]);
  const [activeTab, setActiveTab] = useState<'playlists' | 'recent'>('playlists');

  // Form states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('');
  const [newPlaylistVis, setNewPlaylistVis] = useState<'guild' | 'private' | 'public'>('guild');

  const [addTrackInput, setAddTrackInput] = useState('');
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Fetch playlists
  const fetchPlaylists = async () => {
    try {
      const res = await fetch(`${API_BASE}/playlists`);
      if (res.ok) {
        const data = await res.json();
        setUserPlaylists(data.userPlaylists || []);
        setGuildPlaylists(data.guildPlaylists || []);

        // Keep selected playlist active or select first available
        if (selectedPlaylist) {
          const all = [...(data.userPlaylists || []), ...(data.guildPlaylists || [])];
          const updated = all.find((p) => p.id === selectedPlaylist.id);
          if (updated) {
            setSelectedPlaylist(updated);
          }
        }
      }
    } catch {
      // Offline fallback
    }
  };

  // Fetch tracks for selected playlist
  const fetchPlaylistDetails = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/playlists/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedPlaylist(data.playlist);
        setPlaylistTracks(data.tracks || []);
      }
    } catch {
      // Offline
    }
  };

  // Fetch recent tracks
  const fetchRecentHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/history/recent?guildId=web-dashboard`);
      if (res.ok) {
        const data = await res.json();
        setRecentTracks(data || []);
      }
    } catch {
      // Offline
    }
  };

  useEffect(() => {
    fetchPlaylists();
    fetchRecentHistory();

    // Listen to WebSocket events for real-time playlist synchronization
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket('ws://localhost:3000/ws');
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type && msg.type.startsWith('playlist.')) {
            fetchPlaylists();
            if (selectedPlaylist && msg.playlistId === selectedPlaylist.id) {
              fetchPlaylistDetails(selectedPlaylist.id);
            }
          } else if (msg.type === 'playback.ended' || msg.type === 'playback.started') {
            fetchRecentHistory();
          }
        } catch {
          // Ignore parse errors
        }
      };
    } catch {
      // WebSocket connect failed
    }

    return () => {
      if (ws) ws.close();
    };
  }, [selectedPlaylist?.id]);

  useEffect(() => {
    if (selectedPlaylist) {
      fetchPlaylistDetails(selectedPlaylist.id);
    }
  }, [selectedPlaylist?.id]);

  // Create playlist
  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;

    try {
      const res = await fetch(`${API_BASE}/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPlaylistName.trim(),
          description: newPlaylistDesc.trim() || undefined,
          visibility: newPlaylistVis,
        }),
      });

      if (res.ok) {
        const created = await res.json();
        setNewPlaylistName('');
        setNewPlaylistDesc('');
        setShowCreateModal(false);
        await fetchPlaylists();
        setSelectedPlaylist(created);
        showMessage(`Created playlist "${created.name}"`);
      }
    } catch (err: any) {
      showMessage(`Error creating playlist: ${err.message}`);
    }
  };

  // Delete playlist
  const handleDeletePlaylist = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete playlist "${name}"?`)) return;

    try {
      const res = await fetch(`${API_BASE}/playlists/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showMessage(`Deleted playlist "${name}"`);
        setSelectedPlaylist(null);
        setPlaylistTracks([]);
        await fetchPlaylists();
      }
    } catch (err: any) {
      showMessage(`Error deleting playlist: ${err.message}`);
    }
  };

  // Play playlist
  const handlePlayPlaylist = async (id: string, name: string) => {
    try {
      const res = await fetch(`${API_BASE}/playlists/${id}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'default' }),
      });

      if (res.ok) {
        const data = await res.json();
        showMessage(`Playing playlist "${name}" (${data.enqueuedCount} tracks enqueued)`);
      }
    } catch (err: any) {
      showMessage(`Error playing playlist: ${err.message}`);
    }
  };

  // Add track to playlist
  const handleAddTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlaylist || !addTrackInput.trim()) return;

    setIsAddingTrack(true);
    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: addTrackInput.trim(), addedBy: 'Web Dashboard' }),
      });

      if (res.ok) {
        setAddTrackInput('');
        await fetchPlaylistDetails(selectedPlaylist.id);
        await fetchPlaylists();
        showMessage('Track added to playlist');
      } else {
        const err = await res.json();
        showMessage(`Could not add track: ${err.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      showMessage(`Error: ${err.message}`);
    } finally {
      setIsAddingTrack(false);
    }
  };

  // Remove track
  const handleRemoveTrack = async (position: number) => {
    if (!selectedPlaylist) return;
    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}/tracks/${position}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchPlaylistDetails(selectedPlaylist.id);
        await fetchPlaylists();
        showMessage(`Removed track #${position}`);
      }
    } catch (err: any) {
      showMessage(`Error removing track: ${err.message}`);
    }
  };

  // Reorder track
  const handleReorderTrack = async (fromPos: number, toPos: number) => {
    if (!selectedPlaylist || toPos < 1 || toPos > playlistTracks.length) return;
    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromPosition: fromPos, toPosition: toPos }),
      });
      if (res.ok) {
        await fetchPlaylistDetails(selectedPlaylist.id);
      }
    } catch {
      // Ignore
    }
  };

  const showMessage = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 4000);
  };

  return (
    <section className="card playlist-section" style={{ marginTop: '2rem', width: '100%', maxWidth: '900px' }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <h2 className="card-title" style={{ margin: 0 }}>
            {activeTab === 'playlists' ? '📚 PLAYLISTS' : '🕒 RECENT HISTORY'}
          </h2>
          <div className="tab-group" style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className={`btn btn-secondary ${activeTab === 'playlists' ? 'active' : ''}`}
              onClick={() => setActiveTab('playlists')}
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
            >
              Playlists
            </button>
            <button
              className={`btn btn-secondary ${activeTab === 'recent' ? 'active' : ''}`}
              onClick={() => setActiveTab('recent')}
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
            >
              Recent History
            </button>
          </div>
        </div>

        {activeTab === 'playlists' && (
          <button
            className="btn btn-primary"
            onClick={() => setShowCreateModal(true)}
            style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
          >
            + New Playlist
          </button>
        )}
      </div>

      {statusMessage && (
        <div className="status-banner" style={{ margin: '0.75rem 0', padding: '0.5rem 1rem', background: 'rgba(124, 92, 252, 0.15)', borderRadius: '8px', color: '#a78bfa', fontSize: '0.9rem' }}>
          {statusMessage}
        </div>
      )}

      {/* Create Playlist Modal / Form */}
      {showCreateModal && (
        <div className="create-playlist-box" style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '1rem', borderRadius: '8px', marginBottom: '1.25rem', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: 'var(--text-primary)' }}>Create New Playlist</h3>
          <form onSubmit={handleCreatePlaylist} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <input
                type="text"
                placeholder="Playlist Name (e.g. Synthwave Chill)"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                style={{ flex: 1, padding: '0.5rem 0.75rem', background: '#12121a', border: '1px solid var(--border-color)', color: 'white', borderRadius: '6px' }}
                required
              />
              <select
                value={newPlaylistVis}
                onChange={(e) => setNewPlaylistVis(e.target.value as any)}
                style={{ padding: '0.5rem', background: '#12121a', border: '1px solid var(--border-color)', color: 'white', borderRadius: '6px' }}
              >
                <option value="guild">Server Shared</option>
                <option value="private">Private (Me)</option>
                <option value="public">Public</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Optional description"
              value={newPlaylistDesc}
              onChange={(e) => setNewPlaylistDesc(e.target.value)}
              style={{ padding: '0.5rem 0.75rem', background: '#12121a', border: '1px solid var(--border-color)', color: 'white', borderRadius: '6px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Create Playlist
              </button>
            </div>
          </form>
        </div>
      )}

      {activeTab === 'playlists' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.25rem', marginTop: '1rem' }}>
          {/* Left Column: Playlist Trees */}
          <div style={{ borderRight: '1px solid var(--border-color)', paddingRight: '1rem' }}>
            {/* My Playlists */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                👤 My Playlists ({userPlaylists.length})
              </h4>
              {userPlaylists.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No personal playlists</p>
              ) : (
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {userPlaylists.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => setSelectedPlaylist(p)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: selectedPlaylist?.id === p.id ? 'var(--accent-glow)' : 'transparent',
                        color: selectedPlaylist?.id === p.id ? 'var(--accent)' : 'var(--text-primary)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.9rem',
                        fontWeight: selectedPlaylist?.id === p.id ? 600 : 400,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{p.trackCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Guild Playlists */}
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                🌐 Guild Playlists ({guildPlaylists.length})
              </h4>
              {guildPlaylists.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No server playlists</p>
              ) : (
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {guildPlaylists.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => setSelectedPlaylist(p)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: selectedPlaylist?.id === p.id ? 'var(--accent-glow)' : 'transparent',
                        color: selectedPlaylist?.id === p.id ? 'var(--accent)' : 'var(--text-primary)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.9rem',
                        fontWeight: selectedPlaylist?.id === p.id ? 600 : 400,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{p.trackCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right Column: Selected Playlist Details & Tracks */}
          <div>
            {selectedPlaylist ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {selectedPlaylist.name}
                    </h3>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                      <span className="badge" style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', background: 'rgba(124, 92, 252, 0.2)', color: '#c084fc' }}>
                        {selectedPlaylist.visibility}
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {playlistTracks.length} {playlistTracks.length === 1 ? 'track' : 'tracks'}
                      </span>
                    </div>
                    {selectedPlaylist.description && (
                      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                        {selectedPlaylist.description}
                      </p>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => handlePlayPlaylist(selectedPlaylist.id, selectedPlaylist.name)}
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                      disabled={playlistTracks.length === 0}
                    >
                      ▶ Play in Server
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleDeletePlaylist(selectedPlaylist.id, selectedPlaylist.name)}
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', color: 'var(--error)' }}
                    >
                      🗑 Delete
                    </button>
                  </div>
                </div>

                {/* Add Track Form */}
                <form onSubmit={handleAddTrack} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                  <input
                    type="text"
                    placeholder="Add track by title, URL, or local file..."
                    value={addTrackInput}
                    onChange={(e) => setAddTrackInput(e.target.value)}
                    disabled={isAddingTrack}
                    style={{
                      flex: 1,
                      padding: '0.45rem 0.75rem',
                      background: '#12121a',
                      border: '1px solid var(--border-color)',
                      color: 'white',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                    }}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary"
                    disabled={isAddingTrack || !addTrackInput.trim()}
                    style={{ fontSize: '0.85rem', padding: '0.45rem 0.9rem' }}
                  >
                    {isAddingTrack ? 'Resolving...' : '+ Add'}
                  </button>
                </form>

                {/* Track List Table */}
                {playlistTracks.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textAlign: 'center', padding: '2rem' }}>
                    This playlist has no tracks yet. Add one above!
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {playlistTracks.map((pt) => (
                      <div
                        key={pt.id || `${pt.trackId}_${pt.position}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0.5rem 0.75rem',
                          background: 'rgba(255, 255, 255, 0.02)',
                          borderRadius: '6px',
                          border: '1px solid var(--border-color)',
                          fontSize: '0.85rem',
                        }}
                      >
                        <span style={{ width: '28px', color: 'var(--text-muted)', fontWeight: 600 }}>
                          #{pt.position}
                        </span>

                        <div style={{ flex: 1, minWidth: 0, paddingRight: '0.5rem' }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {pt.track?.title || 'Unknown Title'}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {pt.track?.artist || 'Unknown Artist'}
                            {pt.track?.album ? ` • ${pt.track.album}` : ''}
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <span className="badge" style={{ fontSize: '0.7rem', padding: '0.1rem 0.35rem' }}>
                            {pt.source?.provider || 'local'}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', minWidth: '40px', textAlign: 'right' }}>
                            {formatDuration(pt.track?.duration)}
                          </span>

                          {/* Reorder Buttons */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <button
                              type="button"
                              onClick={() => handleReorderTrack(pt.position, pt.position - 1)}
                              disabled={pt.position <= 1}
                              style={{ background: 'none', border: 'none', color: pt.position <= 1 ? '#444' : 'var(--text-secondary)', cursor: pt.position <= 1 ? 'default' : 'pointer', fontSize: '0.65rem' }}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReorderTrack(pt.position, pt.position + 1)}
                              disabled={pt.position >= playlistTracks.length}
                              style={{ background: 'none', border: 'none', color: pt.position >= playlistTracks.length ? '#444' : 'var(--text-secondary)', cursor: pt.position >= playlistTracks.length ? 'default' : 'pointer', fontSize: '0.65rem' }}
                            >
                              ▼
                            </button>
                          </div>

                          {/* Remove Button */}
                          <button
                            type="button"
                            onClick={() => handleRemoveTrack(pt.position)}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.25rem' }}
                            title="Remove from playlist"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
                Select a playlist on the left or create a new one to view tracks.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Recent History Tab */
        <div style={{ marginTop: '1rem' }}>
          {recentTracks.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
              No playback history recorded yet. Play tracks in Discord or the dashboard!
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {recentTracks.map((r, idx) => (
                <div
                  key={`${r.trackId}_${r.lastPlayedAt}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.6rem 0.9rem',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600, width: '20px' }}>
                      {idx + 1}.
                    </span>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.title}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {r.artist || 'Unknown Artist'} • {new Date(r.lastPlayedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Listened: {formatDuration(r.durationListened)}
                    </span>
                    <span
                      className="badge"
                      style={{
                        fontSize: '0.7rem',
                        background: r.endReason === 'finished' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                        color: r.endReason === 'finished' ? '#4ade80' : '#fcd34d',
                      }}
                    >
                      {r.endReason || 'finished'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
