import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { loadClusterAlbumDetail } from '../utils/serverCluster/clusterDetail';
import { isClusterMode } from '../utils/serverCluster/clusterScope';
import { readClusterSeedServerId } from '../utils/navigation/albumDetailNavigation';

type AlbumPayload = { album: SubsonicAlbum; songs: import('../api/subsonicTypes').SubsonicSong[] };

interface UseAlbumDetailDataResult {
  album: AlbumPayload | null;
  setAlbum: React.Dispatch<React.SetStateAction<AlbumPayload | null>>;
  relatedAlbums: SubsonicAlbum[];
  loading: boolean;
  isStarred: boolean;
  setIsStarred: (v: boolean) => void;
  starredSongs: Set<string>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * Load an album payload by id, then resolve the artist's other albums in
 * a follow-up call so the related-albums grid can render without blocking
 * the initial paint.
 *
 * In cluster mode, loads a virtual aggregate from the merged local index
 * (spec §4) — never falls back to a single-server `getAlbum`.
 */
export function useAlbumDetailData(id: string | undefined): UseAlbumDetailDataResult {
  const location = useLocation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const [album, setAlbum] = useState<AlbumPayload | null>(null);
  const [relatedAlbums, setRelatedAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setRelatedAlbums([]);

    (async () => {
      if (isClusterMode()) {
        const seedServerId = readClusterSeedServerId(location.state) ?? activeServerId ?? '';
        const clusterData = await loadClusterAlbumDetail({ albumId: id, seedServerId });
        if (cancelled) return;
        if (!clusterData) {
          setAlbum(null);
          setLoading(false);
          return;
        }
        const payload: AlbumPayload = { album: clusterData.album, songs: clusterData.songs };
        setAlbum(payload);
        setIsStarred(!!clusterData.album.starred);
        const initialStarred = new Set<string>();
        clusterData.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
        setStarredSongs(initialStarred);
        setRelatedAlbums(clusterData.relatedAlbums);
        setLoading(false);
        return;
      }

      try {
        const data = await getAlbum(id);
        if (cancelled) return;
        setAlbum(data);
        setIsStarred(!!data.album.starred);
        const initialStarred = new Set<string>();
        data.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
        setStarredSongs(initialStarred);
        setLoading(false);
        try {
          const { getArtist } = await import('../api/subsonicArtists');
          const artistData = await getArtist(data.album.artistId);
          if (!cancelled) {
            setRelatedAlbums(artistData.albums.filter(a => a.id !== id));
          }
        } catch (e) {
          console.error('Failed to fetch related albums', e);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id, location.state, activeServerId]);

  return { album, setAlbum, relatedAlbums, loading, isStarred, setIsStarred, starredSongs, setStarredSongs };
}
