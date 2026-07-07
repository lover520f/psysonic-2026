/**
 * Suffix an online browse-catalog key with the library sync revision so a
 * completed resync (renamed/pruned rows) forces a refetch. Single source of the
 * `\0syncrev:` wire format shared by the artist and album browse caches — both
 * the browse hooks and the filter-change prefetch must address the same entry.
 */
export function librarySyncCatalogKey(base: string, syncRevision: number): string {
  return `${base}\0syncrev:${syncRevision}`;
}
