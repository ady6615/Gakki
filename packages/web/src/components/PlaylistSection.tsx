import React, { useEffect, useState } from 'react';

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string | null;
  guildId: string | null;
  visibility: 'public' | 'private' | 'guild';
  trackCount: number;
  coverArt?: string | null;
  isFavorite?: boolean;
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

const API_BASE = '/api';

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

  const [draggedTrackIndex, setDraggedTrackIndex] = useState<number | null>(null);
  const [dropTrackTargetIndex, setDropTrackTargetIndex] = useState<number | null>(null);

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

  const showMessage = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 4000);
  };

  // Batch Reorder (Requirement 8)
  const handleBatchReorder = async (reordered: PlaylistTrackItem[]) => {
    if (!selectedPlaylist) return;
    const backup = [...playlistTracks];
    const reindexed = reordered.map((t, idx) => ({ ...t, position: idx + 1 }));
    setPlaylistTracks(reindexed);

    try {
      const trackIds = reindexed.map((t) => t.trackId);
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}/reorder-batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackIds }),
      });
      if (!res.ok) throw new Error('Reorder failed');
      await fetchPlaylistDetails(selectedPlaylist.id);
    } catch {
      setPlaylistTracks(backup);
      showMessage('Failed to reorder playlist. Reverted changes.');
    }
  };

  // Duplicate Playlist (Requirement 7)
  const handleDuplicatePlaylist = async () => {
    if (!selectedPlaylist) return;
    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: `${selectedPlaylist.name} (Copy)` }),
      });
      if (res.ok) {
        const dup = await res.json();
        showMessage(`Duplicated playlist as "${dup.name}"`);
        await fetchPlaylists();
        setSelectedPlaylist(dup);
      }
    } catch (err: any) {
      showMessage(`Duplicate failed: ${err.message}`);
    }
  };

  // Rename Playlist (Requirement 7)
  const handleRenamePlaylist = async () => {
    if (!selectedPlaylist) return;
    const newName = prompt('Enter new playlist name:', selectedPlaylist.name);
    if (!newName || !newName.trim() || newName.trim() === selectedPlaylist.name) return;

    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSelectedPlaylist((prev) => (prev ? { ...prev, name: updated.name } : null));
        await fetchPlaylists();
        showMessage(`Renamed playlist to "${updated.name}"`);
      }
    } catch (err: any) {
      showMessage(`Rename failed: ${err.message}`);
    }
  };

  // Toggle Favorite Playlist (Requirement 7)
  const handleToggleFavoritePlaylist = async () => {
    if (!selectedPlaylist) return;
    const nextState = !selectedPlaylist.isFavorite;
    try {
      const res = await fetch(`${API_BASE}/playlists/${selectedPlaylist.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFavorite: nextState }),
      });
      if (res.ok) {
        setSelectedPlaylist((prev) => (prev ? { ...prev, isFavorite: nextState } : null));
        await fetchPlaylists();
      }
    } catch {
      // ignore
    }
  };

  // Drag handlers for playlist tracks
  const handleTrackDragStart = (e: React.DragEvent, index: number) => {
    setDraggedTrackIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${index}`);
  };

  const handleTrackDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTrackTargetIndex !== index) {
      setDropTrackTargetIndex(index);
    }
  };

  const handleTrackDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    setDraggedTrackIndex(null);
    setDropTrackTargetIndex(null);

    const sourceStr = e.dataTransfer.getData('text/plain');
    const sourceIndex = parseInt(sourceStr, 10);
    if (isNaN(sourceIndex) || sourceIndex === targetIndex) return;

    const updated = [...playlistTracks];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, moved);
    handleBatchReorder(updated);
  };

  return (
    <section className="playlist-section glass-panel" aria-label="Playlist Management">
      <div className="playlist-section-header">
        <div className="playlist-header-left">
          <h2 className="playlist-main-title">
            {activeTab === 'playlists' ? '📚 PLAYLISTS' : '🕒 RECENT HISTORY'}
          </h2>
          <div className="playlist-tab-buttons">
            <button
              className={`playlist-subtab-btn ${activeTab === 'playlists' ? 'active' : ''}`}
              onClick={() => setActiveTab('playlists')}
            >
              Playlists
            </button>
            <button
              className={`playlist-subtab-btn ${activeTab === 'recent' ? 'active' : ''}`}
              onClick={() => setActiveTab('recent')}
            >
              Recent History
            </button>
          </div>
        </div>

        {activeTab === 'playlists' && (
          <button
            className="create-playlist-trigger-btn"
            onClick={() => setShowCreateModal(true)}
          >
            ➕ New Playlist
          </button>
        )}
      </div>

      {statusMessage && (
        <div className="status-banner">
          {statusMessage}
        </div>
      )}

      {/* Create Playlist Modal / Form */}
      {showCreateModal && (
        <div className="create-playlist-card glass-card">
          <h3 className="create-form-title">Create New Playlist</h3>
          <form onSubmit={handleCreatePlaylist} className="create-playlist-form">
            <div className="form-inputs-row">
              <input
                type="text"
                placeholder="Playlist Name (e.g. Synthwave Chill)"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                className="form-text-input flex-input"
                required
              />
              <select
                value={newPlaylistVis}
                onChange={(e) => setNewPlaylistVis(e.target.value as any)}
                className="form-select-input"
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
              className="form-text-input"
            />
            <div className="form-actions-row">
              <button type="button" className="btn-cancel" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-submit">
                Create Playlist
              </button>
            </div>
          </form>
        </div>
      )}

      {activeTab === 'playlists' ? (
        <div className="playlist-layout-grid">
          {/* Left Column: Playlist Trees */}
          <div className="playlist-sidebar">
            {/* My Playlists */}
            <div className="playlist-category-box">
              <h4 className="sidebar-group-title">
                👤 My Playlists ({userPlaylists.length})
              </h4>
              {userPlaylists.length === 0 ? (
                <p className="sidebar-empty-text">No personal playlists</p>
              ) : (
                <ul className="playlist-nav-list">
                  {userPlaylists.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => setSelectedPlaylist(p)}
                      className={`playlist-nav-item ${selectedPlaylist?.id === p.id ? 'active' : ''}`}
                    >
                      <span className="nav-item-name" title={p.name}>{p.name}</span>
                      <span className="nav-item-count">{p.trackCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Guild Playlists */}
            <div className="playlist-category-box">
              <h4 className="sidebar-group-title">
                🌐 Guild Playlists ({guildPlaylists.length})
              </h4>
              {guildPlaylists.length === 0 ? (
                <p className="sidebar-empty-text">No server playlists</p>
              ) : (
                <ul className="playlist-nav-list">
                  {guildPlaylists.map((p) => (
                    <li
                      key={p.id}
                      onClick={() => setSelectedPlaylist(p)}
                      className={`playlist-nav-item ${selectedPlaylist?.id === p.id ? 'active' : ''}`}
                    >
                      <span className="nav-item-name" title={p.name}>{p.name}</span>
                      <span className="nav-item-count">{p.trackCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right Column: Selected Playlist Details & Tracks */}
          <div className="playlist-main-content">
            {selectedPlaylist ? (
              <div className="playlist-details-container">
                <div className="playlist-top-details-bar">
                  <div className="playlist-details-text">
                    <h3 className="selected-playlist-name" title={selectedPlaylist.name}>
                      {selectedPlaylist.name}
                    </h3>
                    <div className="playlist-meta-badges">
                      <span className="badge visibility-badge">
                        {selectedPlaylist.visibility}
                      </span>
                      <span className="playlist-track-count-text">
                        {playlistTracks.length} {playlistTracks.length === 1 ? 'track' : 'tracks'}
                      </span>
                    </div>
                    {selectedPlaylist.description && (
                      <p className="selected-playlist-desc">
                        {selectedPlaylist.description}
                      </p>
                    )}
                  </div>

                  <div className="playlist-header-action-buttons">
                    <button
                      className="playlist-action-btn"
                      onClick={handleToggleFavoritePlaylist}
                      title={selectedPlaylist.isFavorite ? 'Remove favorite' : 'Mark as favorite'}
                    >
                      {selectedPlaylist.isFavorite ? '❤️' : '🤍'}
                    </button>
                    <button
                      className="playlist-action-btn"
                      onClick={handleRenamePlaylist}
                      title="Rename playlist"
                    >
                      ✏️ Rename
                    </button>
                    <button
                      className="playlist-action-btn"
                      onClick={handleDuplicatePlaylist}
                      title="Duplicate playlist"
                    >
                      📋 Duplicate
                    </button>
                    <button
                      className="playlist-action-btn play-primary"
                      onClick={() => handlePlayPlaylist(selectedPlaylist.id, selectedPlaylist.name)}
                      disabled={playlistTracks.length === 0}
                    >
                      ▶ Play in Server
                    </button>
                    <button
                      className="playlist-action-btn delete-btn"
                      onClick={() => handleDeletePlaylist(selectedPlaylist.id, selectedPlaylist.name)}
                    >
                      🗑 Delete
                    </button>
                  </div>
                </div>

                {/* Add Track Form */}
                <form onSubmit={handleAddTrack} className="playlist-add-track-form">
                  <input
                    type="text"
                    placeholder="Add track by title, URL, or local file..."
                    value={addTrackInput}
                    onChange={(e) => setAddTrackInput(e.target.value)}
                    disabled={isAddingTrack}
                    className="playlist-add-track-input"
                  />
                  <button
                    type="submit"
                    className="playlist-add-track-btn"
                    disabled={isAddingTrack || !addTrackInput.trim()}
                  >
                    {isAddingTrack ? 'Resolving...' : '+ Add'}
                  </button>
                </form>

                {/* Track List Table with Drag-and-Drop (Requirement 8) */}
                {playlistTracks.length === 0 ? (
                  <div className="playlist-empty-state">
                    This playlist has no tracks yet. Add one above!
                  </div>
                ) : (
                  <div className="playlist-tracks-list">
                    {playlistTracks.map((pt, index) => (
                      <div
                        key={pt.id || `${pt.trackId}_${pt.position}`}
                        draggable
                        onDragStart={(e) => handleTrackDragStart(e, index)}
                        onDragOver={(e) => handleTrackDragOver(e, index)}
                        onDrop={(e) => handleTrackDrop(e, index)}
                        className={`playlist-track-row ${draggedTrackIndex === index ? 'dragging' : ''} ${dropTrackTargetIndex === index ? 'drop-target' : ''}`}
                      >
                        <span className="drag-handle" title="Drag to reorder">
                          ☰
                        </span>
                        <span className="playlist-track-pos">
                          #{pt.position}
                        </span>

                        <div className="playlist-track-info">
                          <span className="playlist-track-title" title={pt.track?.title || 'Unknown Title'}>
                            {pt.track?.title || 'Unknown Title'}
                          </span>
                          <span className="playlist-track-meta">
                            {pt.track?.artist || 'Unknown Artist'}
                            {pt.track?.album ? ` • ${pt.track.album}` : ''}
                          </span>
                        </div>

                        <div className="playlist-track-controls">
                          <span className="source-badge provider-badge">
                            {pt.source?.provider || 'local'}
                          </span>
                          <span className="playlist-track-duration">
                            {formatDuration(pt.track?.duration)}
                          </span>

                          {/* Accessible Reorder Buttons */}
                          <div className="playlist-reorder-arrows">
                            <button
                              type="button"
                              onClick={() => {
                                if (index > 0) {
                                  const updated = [...playlistTracks];
                                  const temp = updated[index];
                                  updated[index] = updated[index - 1];
                                  updated[index - 1] = temp;
                                  handleBatchReorder(updated);
                                }
                              }}
                              disabled={index === 0}
                              className="arrow-btn"
                              title="Move track up"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (index < playlistTracks.length - 1) {
                                  const updated = [...playlistTracks];
                                  const temp = updated[index];
                                  updated[index] = updated[index + 1];
                                  updated[index + 1] = temp;
                                  handleBatchReorder(updated);
                                }
                              }}
                              disabled={index >= playlistTracks.length - 1}
                              className="arrow-btn"
                              title="Move track down"
                            >
                              ▼
                            </button>
                          </div>

                          {/* Remove Button */}
                          <button
                            type="button"
                            onClick={() => handleRemoveTrack(pt.position)}
                            className="remove-track-btn"
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
              <div className="playlist-empty-selection">
                Select a playlist on the left or create a new one to view tracks.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Recent History Tab */
        <div className="recent-history-container">
          {recentTracks.length === 0 ? (
            <div className="recent-empty-state">
              No playback history recorded yet. Play tracks in Discord or the dashboard!
            </div>
          ) : (
            <div className="recent-tracks-list">
              {recentTracks.map((r, idx) => (
                <div
                  key={`${r.trackId}_${r.lastPlayedAt}`}
                  className="recent-history-row"
                >
                  <div className="recent-left">
                    <span className="recent-num">
                      {idx + 1}.
                    </span>
                    <div className="recent-text">
                      <span className="recent-title" title={r.title}>{r.title}</span>
                      <span className="recent-sub">
                        {r.artist || 'Unknown Artist'} • {new Date(r.lastPlayedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>

                  <div className="recent-right">
                    <span className="recent-duration">
                      Listened: {formatDuration(r.durationListened)}
                    </span>
                    <span
                      className={`badge end-reason-badge ${r.endReason === 'finished' ? 'finished' : 'skipped'}`}
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
