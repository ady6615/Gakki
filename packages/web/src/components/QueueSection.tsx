import React, { useState } from 'react';
import type { QueueDisplayItem, QueueStatePayload } from './PlaybackStatus';

interface QueueSectionProps {
  queueState: QueueStatePayload;
  guildId: string;
  onRefresh?: () => void;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function QueueSection({ queueState, guildId, onRefresh }: QueueSectionProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [localQueue, setLocalQueue] = useState<QueueDisplayItem[]>(queueState.queue);
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep localQueue in sync with incoming authoritative queueState when not dragging
  React.useEffect(() => {
    if (!isUpdating) {
      setLocalQueue(queueState.queue);
    }
  }, [queueState.queue, isUpdating]);

  const currentTrack = queueState.currentTrack;

  // 1. Drag & Drop Reordering (Requirement 8 & 9)
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${index}`);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTargetIndex !== index) {
      setDropTargetIndex(index);
    }
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
  };

  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    setDraggedIndex(null);
    setDropTargetIndex(null);

    const sourceStr = e.dataTransfer.getData('text/plain');
    const sourceIndex = parseInt(sourceStr, 10);
    if (isNaN(sourceIndex) || sourceIndex === targetIndex) return;

    // Optimistic UI update (Requirement 10)
    const backupQueue = [...localQueue];
    const updated = [...localQueue];
    const [movedItem] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, movedItem);

    // Recalculate 1-based positions for display
    const reindexed = updated.map((item, idx) => ({ ...item, position: idx + 1 }));
    setLocalQueue(reindexed);
    setIsUpdating(true);
    setErrorMessage(null);

    try {
      const orderedTrackIds = reindexed.map((item) => item.id);
      const res = await fetch(`/api/queue/${guildId}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedTrackIds }),
      });

      if (!res.ok) {
        throw new Error('Server rejected queue reorder');
      }
      onRefresh?.();
    } catch (err: any) {
      // Revert optimistic UI on failure
      setLocalQueue(backupQueue);
      setErrorMessage('Failed to reorder queue. Reverted to server state.');
      setTimeout(() => setErrorMessage(null), 4000);
    } finally {
      setIsUpdating(false);
    }
  };

  // 2. Accessible button actions (Requirement 24)
  const handleMoveAction = async (
    trackId: string,
    action: 'top' | 'bottom' | 'next' | 'up' | 'down',
  ) => {
    if (!guildId) return;
    const backupQueue = [...localQueue];
    setIsUpdating(true);
    setErrorMessage(null);

    // Optimistic reorder
    const updated = [...localQueue];
    const idx = updated.findIndex((t) => t.id === trackId);
    if (idx === -1) return;

    if (action === 'top' || action === 'next') {
      const [item] = updated.splice(idx, 1);
      updated.unshift(item);
    } else if (action === 'bottom') {
      const [item] = updated.splice(idx, 1);
      updated.push(item);
    } else if (action === 'up' && idx > 0) {
      const temp = updated[idx];
      updated[idx] = updated[idx - 1];
      updated[idx - 1] = temp;
    } else if (action === 'down' && idx < updated.length - 1) {
      const temp = updated[idx];
      updated[idx] = updated[idx + 1];
      updated[idx + 1] = temp;
    }

    const reindexed = updated.map((item, i) => ({ ...item, position: i + 1 }));
    setLocalQueue(reindexed);

    try {
      const res = await fetch(`/api/queue/${guildId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId, action }),
      });
      if (!res.ok) throw new Error('Action rejected');
      onRefresh?.();
    } catch {
      setLocalQueue(backupQueue);
      setErrorMessage('Action failed. Reverted to server state.');
      setTimeout(() => setErrorMessage(null), 4000);
    } finally {
      setIsUpdating(false);
    }
  };

  // Remove track
  const handleRemove = async (position: number) => {
    if (!guildId) return;
    try {
      await fetch(`/api/queue/${guildId}/tracks/${position}`, { method: 'DELETE' });
      onRefresh?.();
    } catch {
      // ignore
    }
  };

  // Clear queue
  const handleClear = async () => {
    if (!guildId || localQueue.length === 0) return;
    if (!confirm('Clear all queued tracks?')) return;
    try {
      await fetch(`/api/queue/${guildId}`, { method: 'DELETE' });
      setLocalQueue([]);
      onRefresh?.();
    } catch {
      // ignore
    }
  };

  return (
    <section className="queue-container glass-panel" aria-label="Playback Queue Management">
      <div className="queue-header-bar">
        <div className="queue-header-left">
          <h3 className="queue-heading">
            <span className="queue-icon">📜</span> Queue
          </h3>
          <span className="queue-count-pill" aria-label={`${localQueue.length} tracks in queue`}>
            {localQueue.length} {localQueue.length === 1 ? 'track' : 'tracks'}
          </span>
        </div>
        {localQueue.length > 0 && (
          <button
            className="clear-queue-btn"
            onClick={handleClear}
            aria-label="Clear all tracks in queue"
          >
            Clear All
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="queue-error-banner" role="alert">
          ⚠️ {errorMessage}
        </div>
      )}

      {/* Pinned Now Playing (Non-draggable, Requirement 9) */}
      <div className="pinned-now-playing" aria-label="Currently Playing Track">
        <span className="pinned-label">NOW PLAYING</span>
        {currentTrack ? (
          <div className="pinned-track-row">
            <span className="pinned-disc">💿</span>
            <div className="pinned-track-info">
              <span className="pinned-track-name">{currentTrack.name}</span>
              {currentTrack.artist && (
                <span className="pinned-track-artist">{currentTrack.artist}</span>
              )}
            </div>
            <span className="pinned-duration">{formatDuration(currentTrack.duration)}</span>
          </div>
        ) : (
          <div className="pinned-empty">Nothing currently playing</div>
        )}
      </div>

      {/* Draggable Queue List (Requirement 9 & 10) */}
      <div className="queue-list-wrapper">
        <div className="queue-list-label">UPCOMING QUEUE</div>
        {localQueue.length === 0 ? (
          <div className="queue-empty-placeholder">
            <span>Queue is empty.</span>
            <small>Drag songs here or use <code>/play</code> / <code>/addqueue</code> in Discord</small>
          </div>
        ) : (
          <ol className="draggable-queue-list">
            {localQueue.map((item, index) => {
              const isDragging = draggedIndex === index;
              const isOver = dropTargetIndex === index;

              return (
                <li
                  key={item.id || `${item.name}-${index}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  onDrop={(e) => handleDrop(e, index)}
                  className={`queue-row ${isDragging ? 'dragging' : ''} ${isOver ? 'drop-target' : ''}`}
                  tabIndex={0}
                  aria-label={`${item.position}. ${item.name} by ${item.artist || 'Unknown'}`}
                >
                  {/* Drag Handle */}
                  <span
                    className="drag-handle"
                    title="Drag to reorder"
                    aria-hidden="true"
                  >
                    ☰
                  </span>

                  <span className="queue-row-pos">{item.position}</span>

                  <div className="queue-row-info">
                    <span className="queue-row-title" title={item.name}>
                      {item.name}
                    </span>
                    <span className="queue-row-meta">
                      {item.artist || 'Unknown Artist'}
                      {item.addedBy && <span className="added-by-text"> • added by {item.addedBy}</span>}
                    </span>
                  </div>

                  <span className="queue-row-duration">{formatDuration(item.duration)}</span>

                  {/* Accessible action buttons (Requirement 24) */}
                  <div className="queue-row-actions" role="group" aria-label="Track queue actions">
                    <button
                      className="queue-action-btn"
                      onClick={() => handleMoveAction(item.id, 'up')}
                      disabled={index === 0}
                      aria-label="Move track up"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      className="queue-action-btn"
                      onClick={() => handleMoveAction(item.id, 'down')}
                      disabled={index === localQueue.length - 1}
                      aria-label="Move track down"
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      className="queue-action-btn"
                      onClick={() => handleMoveAction(item.id, 'top')}
                      disabled={index === 0}
                      aria-label="Move to top / Play next"
                      title="Play Next"
                    >
                      ⏭️
                    </button>
                    <button
                      className="queue-action-btn remove-btn"
                      onClick={() => handleRemove(item.position)}
                      aria-label={`Remove ${item.name} from queue`}
                      title="Remove from queue"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
