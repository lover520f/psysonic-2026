import { useState } from 'react';
import { Download } from 'lucide-react';
import Modal from './Modal';

interface Props {
  onConfirm: (since: number) => void;
  onClose: () => void;
}

export default function ExportPickerModal({ onConfirm, onClose }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);

  const handleConfirm = () => {
    const since = new Date(date + 'T00:00:00').getTime();
    onConfirm(since);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Alben exportieren"
      size="sm"
      closeLabel="Abbrechen"
      bodyClassName="ui-modal-body--padded"
      footer={
        <>
          <button className="btn btn-surface" onClick={onClose}>Abbrechen</button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!date}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Download size={15} />
            Exportieren
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Alle Alben exportieren, die seit diesem Datum hinzugekommen sind:
      </p>
      <input
        type="date"
        value={date}
        max={today}
        onChange={e => {
          setDate(e.target.value);
          e.target.blur();
        }}
        style={{
          width: '100%',
          padding: '9px 12px',
          borderRadius: '8px',
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          fontSize: '14px',
          boxSizing: 'border-box',
          outline: 'none',
          colorScheme: 'dark',
        }}
      />
    </Modal>
  );
}
