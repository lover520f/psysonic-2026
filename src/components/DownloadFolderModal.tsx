import { FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { useAuthStore } from '../store/authStore';
import Modal from './Modal';

export default function DownloadFolderModal() {
  const { isOpen, folder, remember, setFolder, setRemember, confirm, cancel } = useDownloadModalStore();
  const setDownloadFolder = useAuthStore(s => s.setDownloadFolder);
  const { t } = useTranslation();

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('common.chooseDownloadFolder') });
    if (selected && typeof selected === 'string') setFolder(selected);
  };

  return (
    <Modal
      open={isOpen}
      onClose={cancel}
      title={t('common.chooseDownloadFolder')}
      size="md"
      closeLabel={t('common.cancel')}
      bodyClassName="ui-modal-body--padded"
      footer={
        <>
          <button className="btn btn-ghost" onClick={cancel}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            onClick={() => confirm(setDownloadFolder)}
            disabled={!folder}
          >
            {t('common.download')}
          </button>
        </>
      }
    >
      <div className="download-folder-pick-row">
        <span className="download-folder-path">
          {folder || t('common.noFolderSelected')}
        </span>
        <button className="btn btn-ghost" onClick={handleBrowse} style={{ flexShrink: 0 }}>
          <FolderOpen size={15} /> {t('settings.pickFolder')}
        </button>
      </div>

      <label className="download-remember-row">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
        <span>{t('common.rememberDownloadFolder')}</span>
      </label>
    </Modal>
  );
}
