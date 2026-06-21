import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';

interface Props {
  onClose: () => void;
  onSave: (name: string) => void;
}

export function SavePlaylistModal({ onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const submit = () => { if (name.trim()) onSave(name.trim()); };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('queue.savePlaylist')}
      size="sm"
      closeLabel={t('queue.cancel')}
      bodyClassName="ui-modal-body--padded"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>{t('queue.cancel')}</button>
          <button className="btn btn-primary" onClick={submit}>{t('queue.save')}</button>
        </>
      }
    >
      <input
        type="text"
        className="live-search-field"
        placeholder={t('queue.playlistName')}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        style={{ width: '100%', padding: '10px 16px' }}
      />
    </Modal>
  );
}
