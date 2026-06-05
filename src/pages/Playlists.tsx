import { getPlaylist } from '../api/subsonicPlaylists';
import { getGenres } from '../api/subsonicGenres';
import { apiForServer } from '../api/subsonicClient';
import { filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicGenre, SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store/playerStore';
import { usePlaylistStore } from '../store/playlistStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useRangeSelection } from '../hooks/useRangeSelection';

import { formatHumanHoursMinutes } from '../utils/format/formatHumanDuration';
import {
  defaultSmartFilters, isSmartPlaylistName,
  type SmartFilters, type PendingSmartPlaylist,
} from '../utils/playlist/playlistsSmart';
import { useSmartCoverCollage } from '../hooks/useSmartCoverCollage';
import { usePlaylistsLibraryScopeCounts } from '../hooks/usePlaylistsLibraryScopeCounts';
import { usePendingSmartPolling } from '../hooks/usePendingSmartPolling';
import { runPlaylistsOpenSmartEditor } from '../utils/playlist/runPlaylistsOpenSmartEditor';
import { runPlaylistsSaveSmart } from '../utils/playlist/runPlaylistsSaveSmart';
import {
  runPlaylistDelete, runPlaylistDeleteSelected, runPlaylistMergeSelected,
} from '../utils/playlist/runPlaylistsActions';
import PlaylistsSmartEditor from '../components/playlists/PlaylistsSmartEditor';
import PlaylistsHeader from '../components/playlists/PlaylistsHeader';
import PlaylistCard from '../components/playlists/PlaylistCard';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { isClusterMode } from '../utils/serverCluster/clusterScope';
import { resolveClusterBrowseMembers } from '../utils/serverCluster/clusterBrowse';
import { serverListDisplayLabel } from '../utils/server/serverDisplayName';

function formatDuration(seconds: number): string {
  return formatHumanHoursMinutes(seconds);
}

export default function Playlists() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const navigate = useNavigate();
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const playlistsLoading = usePlaylistStore((s) => s.playlistsLoading);
  const activeUsername = useAuthStore(s => s.getActiveServer()?.username ?? '');
  const activeServerId = useAuthStore(s => s.activeServerId);
  const subsonicIdentityByServer = useAuthStore(s => s.subsonicServerIdentityByServer);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [newName, setNewName] = useState('');
  const [smartFilters, setSmartFilters] = useState<SmartFilters>(defaultSmartFilters);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [genreQuery, setGenreQuery] = useState('');
  const [creatingSmartBusy, setCreatingSmartBusy] = useState(false);
  const [editingSmartId, setEditingSmartId] = useState<string | null>(null);
  const [pendingSmart, setPendingSmart] = useState<PendingSmartPlaylist[]>([]);
  const smartCoverIdsByPlaylist = useSmartCoverCollage(playlists, musicLibraryFilterVersion);
  const { filteredSongCountByPlaylist, filteredDurationByPlaylist } =
    usePlaylistsLibraryScopeCounts(playlists, musicLibraryFilterVersion);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [clusterGroups, setClusterGroups] = useState<Array<{ serverId: string; label: string; playlists: SubsonicPlaylist[] }>>([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(playlists);
  const isNavidromeServer = Boolean(
    activeServerId &&
    (subsonicIdentityByServer[activeServerId]?.type ?? '').toLowerCase() === 'navidrome',
  );

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const selectedPlaylists = playlists.filter(p => selectedIds.has(p.id));
  const isPlaylistDeletable = useCallback((pl: SubsonicPlaylist) => {
    if (!pl.owner) return true;
    if (!activeUsername) return false;
    return pl.owner === activeUsername;
  }, [activeUsername]);

  useEffect(() => {
    fetchPlaylists().finally(() => setLoading(false));
    getGenres().then(setGenres).catch(() => {});
  }, [fetchPlaylists]);

  useEffect(() => {
    if (!isClusterMode()) return;
    let cancelled = false;
    setClusterLoading(true);
    void (async () => {
      const members = await resolveClusterBrowseMembers();
      if (!members || members.length === 0) {
        if (!cancelled) {
          setClusterGroups([]);
          setClusterLoading(false);
        }
        return;
      }
      const all = useAuthStore.getState().servers;
      const settled = await Promise.allSettled(
        members.map(async (serverId: string) => {
          const data = await apiForServer<{ playlists?: { playlist?: SubsonicPlaylist[] } }>(
            serverId,
            'getPlaylists.view',
            { _t: Date.now() },
          );
          const playlistsForServer = (data.playlists?.playlist ?? []).filter(p => !p.name.startsWith('__psyorbit_'));
          const server = all.find(s => s.id === serverId);
          const label = server ? serverListDisplayLabel(server, all) : serverId;
          return { serverId, label, playlists: playlistsForServer };
        }),
      );
      if (cancelled) return;
      const groups: Array<{ serverId: string; label: string; playlists: SubsonicPlaylist[] }> = [];
      settled.forEach((r) => {
        if (r.status === 'fulfilled') groups.push(r.value);
      });
      setClusterGroups(groups);
      setClusterLoading(false);
    })();
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const createPlaylist = usePlaylistStore(s => s.createPlaylist);

  const availableGenres = genres
    .map(g => g.value)
    .filter(v => !smartFilters.selectedGenres.includes(v))
    .filter(v => !genreQuery.trim() || v.toLowerCase().includes(genreQuery.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const handleCreate = async () => {
    const name = newName.trim() || t('playlists.unnamed');
    await createPlaylist(name);
    // Refresh playlists from API to get the new one
    await fetchPlaylists();
    setCreating(false);
    setNewName('');
  };

  const handleOpenSmartEditor = (pl: SubsonicPlaylist) => runPlaylistsOpenSmartEditor({
    pl, isNavidromeServer, allGenres: genres, t,
    setSmartFilters, setEditingSmartId, setGenreQuery,
    setCreating, setCreatingSmart, setCreatingSmartBusy,
  });

  const handleCreateSmart = () => runPlaylistsSaveSmart({
    isNavidromeServer, smartFilters, allGenres: genres.map(g => g.value), editingSmartId, playlists, fetchPlaylists, t,
    setPendingSmart, setCreatingSmart, setEditingSmartId, setSmartFilters,
    setGenreQuery, setCreatingSmartBusy,
  });

  // Smart playlist rules are processed asynchronously on server.
  usePendingSmartPolling(pendingSmart, setPendingSmart, fetchPlaylists);

  const handlePlay = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    if (playingId === pl.id) return;
    setPlayingId(pl.id);
    try {
      const data = await getPlaylist(pl.id);
      const filteredSongs = await filterSongsToActiveLibrary(data.songs);
      const tracks = filteredSongs.map(songToTrack);
      if (tracks.length > 0) {
        touchPlaylist(pl.id);
        playTrack(tracks[0], tracks);
      }
    } catch {}
    setPlayingId(null);
  };

  const handleDelete = (e: React.MouseEvent, pl: SubsonicPlaylist) => runPlaylistDelete({
    e, pl, deleteConfirmId, setDeleteConfirmId, removeId, t,
  });

  const handleDeleteSelected = () => runPlaylistDeleteSelected({
    selectedPlaylists, selectedIds, isPlaylistDeletable, removeId, clearSelection, t,
  });

  const handleMergeSelected = (targetPlaylist: SubsonicPlaylist) => runPlaylistMergeSelected({
    targetPlaylist, selectedPlaylists, touchPlaylist, clearSelection, t,
  });

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (isClusterMode()) {
    return (
      <div className="content-body animate-fade-in">
        <h1 className="page-title">{t('playlists.title')}</h1>
        {clusterLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
            <div className="spinner" />
          </div>
        ) : clusterGroups.length === 0 ? (
          <div className="empty-state">{t('playlists.empty')}</div>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {clusterGroups.map(group => (
              <section key={group.serverId}>
                <h3 style={{ margin: '0 0 10px' }}>{group.label}</h3>
                {group.playlists.length === 0 ? (
                  <div className="empty-state" style={{ padding: '10px 0' }}>{t('playlists.empty')}</div>
                ) : (
                  <div className="playlist-grid">
                    {group.playlists.map(pl => (
                      <button
                        key={`${group.serverId}:${pl.id}`}
                        className="btn btn-secondary"
                        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}
                        onClick={async () => {
                          if (playingId === `${group.serverId}:${pl.id}`) return;
                          setPlayingId(`${group.serverId}:${pl.id}`);
                          try {
                            const data = await apiForServer<{ playlist: SubsonicPlaylist & { entry?: SubsonicSong[] } }>(
                              group.serverId,
                              'getPlaylist.view',
                              { id: pl.id },
                            );
                            const tracks = (data.playlist.entry ?? [])
                              .map(song => ({ ...song, clusterBrowseServerId: group.serverId }))
                              .map(songToTrack);
                            if (tracks.length > 0) playTrack(tracks[0], tracks);
                          } catch {}
                          setPlayingId(null);
                        }}
                      >
                        <span>{pl.name}</span>
                        <span style={{ opacity: 0.75 }}>{pl.songCount ?? 0}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="content-body animate-fade-in">
      <style>{`
        .dual-year-range {
          position: relative;
          height: 34px;
        }
        .dual-year-range__track,
        .dual-year-range__selected {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          height: 4px;
          transform: translateY(-50%);
          border-radius: 999px;
        }
        .dual-year-range__track { background: var(--border); }
        .dual-year-range__selected { background: var(--accent); }
        .dual-year-range input[type='range'] {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 34px;
          margin: 0;
          background: transparent;
          -webkit-appearance: none;
          appearance: none;
          pointer-events: none;
        }
        .dual-year-range input[type='range']::-webkit-slider-runnable-track { height: 4px; background: transparent; }
        .dual-year-range input[type='range']::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          margin-top: -5px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-card);
          pointer-events: auto;
          cursor: pointer;
        }
      `}</style>

      <PlaylistsHeader
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        selectedPlaylists={selectedPlaylists}
        isPlaylistDeletable={isPlaylistDeletable}
        toggleSelectionMode={toggleSelectionMode}
        handleDeleteSelected={handleDeleteSelected}
        creating={creating}
        setCreating={setCreating}
        setCreatingSmart={setCreatingSmart}
        newName={newName}
        setNewName={setNewName}
        nameInputRef={nameInputRef}
        handleCreate={handleCreate}
        isNavidromeServer={isNavidromeServer}
        setEditingSmartId={setEditingSmartId}
        setSmartFilters={setSmartFilters}
        setGenreQuery={setGenreQuery}
      />

      {creatingSmart && (
        <PlaylistsSmartEditor
          smartFilters={smartFilters}
          setSmartFilters={setSmartFilters}
          availableGenres={availableGenres}
          genreQuery={genreQuery}
          setGenreQuery={setGenreQuery}
          editingSmartId={editingSmartId}
          creatingSmartBusy={creatingSmartBusy}
          setCreatingSmart={setCreatingSmart}
          setEditingSmartId={setEditingSmartId}
          onSave={handleCreateSmart}
        />
      )}

      {/* ── Grid ── */}
      {playlists.length === 0 ? (
        <div className="empty-state">{t('playlists.empty')}</div>
      ) : (
        <VirtualCardGrid
          items={playlists}
          itemKey={(pl, _i) => pl.id}
          rowVariant="playlist"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={playlists.length}
          renderItem={pl => (
            <PlaylistCard
              pl={pl}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              selectedPlaylists={selectedPlaylists}
              toggleSelect={toggleSelect}
              isPlaylistDeletable={isPlaylistDeletable}
              deleteConfirmId={deleteConfirmId}
              setDeleteConfirmId={setDeleteConfirmId}
              handleOpenSmartEditor={handleOpenSmartEditor}
              handleDelete={handleDelete}
              handlePlay={handlePlay}
              playingId={playingId}
              smartCoverIdsByPlaylist={smartCoverIdsByPlaylist}
              pendingSmart={pendingSmart}
              filteredSongCountByPlaylist={filteredSongCountByPlaylist}
              filteredDurationByPlaylist={filteredDurationByPlaylist}
            />
          )}
        />
      )}


    </div>
  );
}
