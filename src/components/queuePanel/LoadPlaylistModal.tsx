import { useEffect, useState } from 'react';
import { Play, Trash2, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getPlaylists, deletePlaylist } from '../../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import Modal from '../Modal';
import ConfirmDialog from '../ConfirmDialog';

interface Props {
  onClose: () => void;
  onLoad: (id: string, name: string, mode: 'replace' | 'append') => void;
}

export function LoadPlaylistModal({ onClose, onLoad }: Props) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<SubsonicPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const fetchPlaylists = () => {
    setLoading(true);
    getPlaylists().then(data => {
      setPlaylists(data);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  };

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPlaylists();
  }, []);

  const handleDelete = (id: string, name: string) => {
    setConfirmDelete({ id, name });
  };

  const confirmDeletePlaylist = async () => {
    if (!confirmDelete) return;
    await deletePlaylist(confirmDelete.id);
    setConfirmDelete(null);
    fetchPlaylists();
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={t('queue.loadPlaylist')}
        size="md"
        closeLabel={t('queue.cancel')}
        bodyClassName="ui-modal-body--padded"
      >
        {!loading && playlists.length > 0 && (
          <input
            type="text"
            className="live-search-field"
            placeholder={t('queue.filterPlaylists')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem', padding: '8px 14px' }}
          />
        )}
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.loading')}</p>
        ) : playlists.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.noPlaylists')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
            {playlists.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())).map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-hover)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontWeight: 500 }} className="truncate" data-tooltip={p.name}>{p.name}</span>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'replace')} data-tooltip={t('queue.load')} style={{ width: '28px', height: '28px', background: 'transparent' }}><Play size={14} /></button>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'append')} data-tooltip={t('queue.appendToQueue')} style={{ width: '28px', height: '28px', background: 'transparent' }}><ListPlus size={14} /></button>
                  <button className="nav-btn" onClick={() => handleDelete(p.id, p.name)} data-tooltip={t('queue.delete')} style={{ width: '28px', height: '28px', background: 'transparent', color: 'var(--danger)' }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('queue.delete')}
        message={confirmDelete ? t('queue.deleteConfirm', { name: confirmDelete.name }) : ''}
        confirmLabel={t('queue.delete')}
        cancelLabel={t('queue.cancel')}
        danger
        onConfirm={confirmDeletePlaylist}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}
