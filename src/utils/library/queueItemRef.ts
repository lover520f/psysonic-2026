import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { canonicalQueueServerKey } from '../server/serverIndexKey';

export function toQueueItemRefs(serverId: string, queue: Track[]): QueueItemRef[] {
  const canonicalId = canonicalQueueServerKey(serverId);
  return queue.map(t => toQueueItemRef(canonicalId, t));
}

/** Per-track server ids (mixed-server / cluster-resolved queues). */
export function toQueueItemRefsMulti(
  entries: Array<{ serverId: string; track: Track }>,
): QueueItemRef[] {
  return entries.map(({ serverId, track }) =>
    toQueueItemRef(canonicalQueueServerKey(serverId), track),
  );
}

function toQueueItemRef(canonicalId: string, t: Track): QueueItemRef {
    const ref: QueueItemRef = { serverId: canonicalId, trackId: t.id };
    if (t.autoAdded) ref.autoAdded = true;
    if (t.radioAdded) ref.radioAdded = true;
    if (t.playNextAdded) ref.playNextAdded = true;
    return ref;
}
