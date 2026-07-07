import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import { albumBrowseBootstrapEligible, fetchLocalAlbumCatalogChunk } from './albumBrowseLoad';
import type { AlbumBrowseQuery } from './albumBrowseTypes';
import { scheduleAlbumBrowseBackgroundWork } from './albumBrowseBackground';
import { emitAlbumBrowseDebug } from './albumBrowseDebug';
import {
  ALBUM_BROWSE_BOOTSTRAP_CHUNK,
  albumBrowseCatalogCacheKey,
  albumBrowseCatalogInflight,
  albumBrowseInitialLoadKey,
  albumBrowseOnlineCatalogKey,
  fetchAlbumBrowseCatalogDeduped,
  readAlbumBrowseCatalogCache,
} from './albumBrowseInflight';

const DEFAULT_PREFETCH_QUERY: AlbumBrowseQuery = {
  sort: 'alphabeticalByName',
  genres: [],
  losslessOnly: false,
  starredOnly: false,
  compFilter: 'all',
};

/**
 * Warm the first catalog chunk after the sidebar library filter changes.
 * `librarySyncRevision` is supplied by the caller (app layer) so the warmed key
 * matches the browse hook's online key without `src/lib` importing `src/store`.
 */
export function prefetchAlbumBrowseCatalogAfterFilterChange(
  serverId: string,
  libraryFilterVersion: number,
  indexEnabled: boolean,
  librarySyncRevision: number,
): void {
  if (!serverId) return;
  if (!indexEnabled) return;

  const query = DEFAULT_PREFETCH_QUERY;
  if (!albumBrowseBootstrapEligible(query)) return;

  const loadKey = albumBrowseOnlineCatalogKey(
    albumBrowseInitialLoadKey(serverId, libraryFilterVersion, query, false),
    librarySyncRevision,
  );
  if (readAlbumBrowseCatalogCache(loadKey)) return;

  const bootKey = albumBrowseCatalogCacheKey(
    loadKey,
    ALBUM_BROWSE_BOOTSTRAP_CHUNK,
    200,
  );
  if (albumBrowseCatalogInflight(loadKey) || albumBrowseCatalogInflight(bootKey)) return;

  scheduleAlbumBrowseBackgroundWork(() => {
    emitAlbumBrowseDebug('catalog_prefetch_start', {
      libraryFilterVersion,
      libraryScopeCount: librarySelectionForServer(serverId).length,
    });
    void fetchAlbumBrowseCatalogDeduped(bootKey, () =>
      fetchLocalAlbumCatalogChunk(
        serverId,
        indexEnabled,
        query,
        0,
        ALBUM_BROWSE_BOOTSTRAP_CHUNK,
      ),
    ).then(result => {
      if (result != null) {
        emitAlbumBrowseDebug('catalog_prefetch_done', { albumCount: result.albums.length });
      }
    });
  });
}
