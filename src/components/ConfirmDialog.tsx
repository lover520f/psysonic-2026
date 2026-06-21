import { type ReactNode, useRef } from 'react';
import Modal from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /**
   * Cancel button label. Omit (together with `onCancel`) to render a
   * single-button info dialog — Esc / backdrop / X then resolve via `onConfirm`.
   */
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  /**
   * While busy (e.g. a delete in flight) the dialog can't be dismissed via
   * backdrop/Escape and the buttons are disabled.
   */
  busy?: boolean;
}

/**
 * Confirm/cancel (or single-button info) dialog on top of {@link Modal}. The
 * confirm button takes initial focus so Enter confirms natively (no Enter
 * hijack). Used for ConfirmModal, the LoadPlaylist delete prompt, the analytics
 * clear-confirm and the Orbit exit prompt.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dismiss = onCancel ?? onConfirm;
  const confirmStyle = danger
    ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
    : undefined;

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={title}
      size="sm"
      closeLabel={cancelLabel ?? confirmLabel}
      initialFocusRef={confirmRef}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      bodyClassName="ui-modal-body--padded"
      footer={
        <>
          {cancelLabel && onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            ref={confirmRef}
            className="btn btn-primary"
            style={confirmStyle}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-dialog-message">{message}</p>
    </Modal>
  );
}
