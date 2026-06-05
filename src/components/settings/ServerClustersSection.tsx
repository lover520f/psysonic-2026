import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { serverListDisplayLabel } from '../../utils/server/serverDisplayName';
import { switchActiveCluster } from '../../utils/server/switchActiveServer';
import type { ServerCluster } from '../../utils/serverCluster/types';
import {
  getClusterMergeDiagnostics,
  type ClusterMergeDiagnostics,
} from '../../utils/serverCluster/clusterMergeStatus';

type MemberDropTarget = { idx: number; before: boolean } | null;

export function ServerClustersSection() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const psyDragState = useDragDrop();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [memberDropTarget, setMemberDropTarget] = useState<MemberDropTarget>(null);
  const [diagnosticsByCluster, setDiagnosticsByCluster] = useState<Record<string, ClusterMergeDiagnostics>>({});
  const memberDropRef = useRef<MemberDropTarget>(null);
  const dragClusterIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const showSection = auth.servers.length >= 2;

  useEffect(() => {
    if (!psyDragState.isDragging) {
      memberDropRef.current = null;
      setMemberDropTarget(null);
      dragClusterIdRef.current = null;
    }
  }, [psyDragState.isDragging]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(auth.clusters.map(async cluster => {
      const diag = await getClusterMergeDiagnostics(cluster);
      return [cluster.id, diag] as const;
    })).then(entries => {
      if (cancelled) return;
      setDiagnosticsByCluster(Object.fromEntries(entries));
    }).catch(() => {
      if (!cancelled) setDiagnosticsByCluster({});
    });
    return () => { cancelled = true; };
  }, [auth.clusters, auth.servers, auth.activeClusterId, auth.musicLibraryFilterVersion]);

  const startCreate = () => {
    setCreating(true);
    setNewName('');
    setSelectedIds([]);
  };

  const toggleMemberPick = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  const saveCreate = () => {
    if (selectedIds.length < 2) return;
    try {
      auth.createCluster(newName, selectedIds);
      setCreating(false);
    } catch {
      /* validation */
    }
  };

  const activateCluster = async (cluster: ServerCluster) => {
    await switchActiveCluster(cluster.id);
  };

  const handleMemberDragMove = (clusterId: string, e: React.MouseEvent) => {
    if (!psyDragState.isDragging || !containerRef.current) return;
    dragClusterIdRef.current = clusterId;
    const rows = containerRef.current.querySelectorAll<HTMLElement>(
      `[data-cluster-member="${clusterId}"]`,
    );
    let target: MemberDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.memberIdx);
      if (e.clientY < rect.top + rect.height / 2) {
        target = { idx, before: true };
        break;
      }
      target = { idx, before: false };
    }
    memberDropRef.current = target;
    setMemberDropTarget(target);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; clusterId?: string; index?: number };
      try {
        parsed = JSON.parse(detail.data as string);
      } catch {
        return;
      }
      if (parsed.type !== 'cluster_member_reorder' || parsed.index == null || !parsed.clusterId) return;
      const clusterId = parsed.clusterId;
      const target = memberDropRef.current;
      memberDropRef.current = null;
      setMemberDropTarget(null);
      if (!target) return;

      const cluster = auth.clusters.find(c => c.id === clusterId);
      if (!cluster) return;

      const fromIdx = parsed.index;
      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...cluster.serverIds];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      auth.setClusterOrder(clusterId, next);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [auth]);

  if (!showSection) return null;

  return (
    <section className="settings-section" style={{ marginTop: '1.5rem' }}>
      <div className="settings-section-header">
        <Layers size={18} />
        <h2>{t('settings.clustersTitle')}</h2>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {t('settings.clustersHint')}
      </p>

      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {auth.clusters.map(cluster => {
          const isActive = auth.activeClusterId === cluster.id;
          const isEditing = editingId === cluster.id;
          return (
            <div
              key={cluster.id}
              className="settings-card"
              style={{
                border: isActive ? '1px solid var(--accent)' : undefined,
                background: isActive
                  ? 'color-mix(in srgb, var(--accent) 10%, var(--bg-card))'
                  : undefined,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                {isEditing ? (
                  <input
                    className="input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    style={{ flex: 1, minWidth: 120 }}
                  />
                ) : (
                  <div>
                    <div style={{ fontWeight: 600 }}>{cluster.name}</div>
                    {isActive && (
                      <span
                        style={{
                          fontSize: 11,
                          background: 'var(--accent)',
                          color: 'var(--ctp-crust)',
                          padding: '1px 6px',
                          borderRadius: 'var(--radius-sm)',
                          fontWeight: 600,
                        }}
                      >
                        {t('settings.clusterActive')}
                      </span>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  {!isActive && (
                    <button type="button" className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => void activateCluster(cluster)}>
                      {t('settings.useCluster')}
                    </button>
                  )}
                  {isEditing ? (
                    <button
                      type="button"
                      className="btn btn-surface"
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        auth.renameCluster(cluster.id, editName);
                        setEditingId(null);
                      }}
                    >
                      {t('common.save')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditingId(cluster.id);
                        setEditName(cluster.name);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => auth.deleteCluster(cluster.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div
                style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: 4 }}
                onMouseMove={e => handleMemberDragMove(cluster.id, e)}
              >
                {cluster.serverIds.map((sid, memberIdx) => {
                  const srv = auth.servers.find(s => s.id === sid);
                  if (!srv) return null;
                  const status = diagnosticsByCluster[cluster.id]?.members.find(m => m.serverId === sid);
                  const statusLabel = !status
                    ? ''
                    : status.included
                      ? t('cluster.memberIncluded')
                      : status.reason === 'indexing'
                        ? t('cluster.memberExcludedIndexing')
                        : t('cluster.memberExcludedOffline');
                  const isBefore =
                    psyDragState.isDragging &&
                    dragClusterIdRef.current === cluster.id &&
                    memberDropTarget?.idx === memberIdx &&
                    memberDropTarget.before;
                  const isAfter =
                    psyDragState.isDragging &&
                    dragClusterIdRef.current === cluster.id &&
                    memberDropTarget?.idx === memberIdx &&
                    !memberDropTarget.before;
                  return (
                    <div
                      key={sid}
                      data-cluster-member={cluster.id}
                      data-member-idx={memberIdx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        boxShadow: isBefore
                          ? 'inset 0 2px 0 0 var(--accent)'
                          : isAfter
                          ? 'inset 0 -2px 0 0 var(--accent)'
                          : undefined,
                      }}
                    >
                      <ClusterMemberGrip clusterId={cluster.id} idx={memberIdx} label={cluster.name} />
                      <span style={{ flex: 1 }}>{serverListDisplayLabel(srv, auth.servers)}</span>
                      {statusLabel && (
                        <span style={{ fontSize: 11, color: status?.included ? 'var(--text-muted)' : 'var(--warning)' }}>
                          {statusLabel}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => auth.removeServerFromCluster(cluster.id, sid)}
                      >
                        {t('settings.clusterRemoveMember')}
                      </button>
                    </div>
                  );
                })}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={cluster.clusterSyncPlayCounts}
                  onChange={e => auth.setClusterSyncPlayCounts(cluster.id, e.target.checked)}
                />
                {t('settings.clusterSyncPlayCounts')}
              </label>
              {cluster.clusterSyncPlayCounts && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  {t('settings.clusterSyncPlayCountsWarn')}
                </p>
              )}
            </div>
          );
        })}

        {creating ? (
          <div className="settings-card">
            <input
              className="input"
              placeholder={t('settings.clusterNamePlaceholder')}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              style={{ marginBottom: 8, width: '100%' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {auth.servers.map(srv => (
                <label key={srv.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(srv.id)}
                    onChange={() => toggleMemberPick(srv.id)}
                  />
                  {serverListDisplayLabel(srv, auth.servers)}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-primary" disabled={selectedIds.length < 2} onClick={saveCreate}>
                {t('settings.clusterCreate')}
              </button>
              <button type="button" className="btn btn-surface" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-surface" onClick={startCreate}>
            <Plus size={14} />
            {t('settings.clusterAdd')}
          </button>
        )}
      </div>
    </section>
  );
}

function ClusterMemberGrip({
  clusterId,
  idx,
  label,
}: {
  clusterId: string;
  idx: number;
  label: string;
}) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'cluster_member_reorder', clusterId, index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
    >
      <Layers size={14} />
    </span>
  );
}
