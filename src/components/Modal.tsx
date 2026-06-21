import { type ReactNode, type Ref, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Selector for tabbable elements used by the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Body scroll-lock with a module-level ref count so nested modals (e.g.
 * LoadPlaylist → delete-confirm, Join → AccountPicker) don't release the lock
 * while an outer modal is still open.
 */
let scrollLockCount = 0;
function lockBodyScroll() {
  if (scrollLockCount === 0) document.body.style.overflow = 'hidden';
  scrollLockCount += 1;
}
function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = '';
}

interface ModalProps {
  open: boolean;
  /** Called on Escape, backdrop click, and the header close button. */
  onClose: () => void;
  title: ReactNode;
  /** Smaller line under the title (e.g. a version range). */
  subtitle?: ReactNode;
  /** Leading icon, aligned with the title line. */
  icon?: ReactNode;
  /** Action row pinned to the bottom, above the modal edge. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the header close (X) button. */
  hideClose?: boolean;
  /** Accessible label / tooltip for the close button. */
  closeLabel?: string;
  /**
   * Focus target when the modal opens. Falls back to the first focusable
   * element, then the dialog card. Use it for the primary action (Confirm/OK)
   * or the first form field so Enter activates the right control natively.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Backdrop click closes the modal. Default `true`. */
  closeOnBackdrop?: boolean;
  /** Escape closes the modal. Default `true`. */
  closeOnEscape?: boolean;
  /** `perf` = opaque backdrop, no enter/backdrop animation (sidebar perf probe). */
  variant?: 'perf';
  /** Extra class(es) on `.ui-modal-body` (e.g. `ui-modal-body--padded`). */
  bodyClassName?: string;
  /** Forwarded to `.ui-modal-body` (scroll root for IntersectionObserver / keyboard nav). */
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/**
 * Reusable modal shell: a portal to `document.body` with an opaque, centered
 * card over a dimmed backdrop. Closes on Escape, backdrop click and the header
 * X (each guardable via `closeOnEscape` / `closeOnBackdrop`). Deliberately uses
 * **no `backdrop-filter`** — on WebKitGTK (some GPU stacks) the blur bleeds onto
 * the modal content, making text look unfocused.
 *
 * Keyboard / a11y is handled here once so every consumer inherits it: focus
 * trap (Tab/Shift+Tab cycle inside the card), initial focus, focus restore to
 * the opening element, `aria-labelledby` on the title, and a ref-counted body
 * scroll-lock. Enter is **not** hijacked — it activates the focused control
 * natively; roving lists keep their own Arrow/Enter handlers in `children`.
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  footer,
  size = 'md',
  hideClose,
  closeLabel,
  initialFocusRef,
  closeOnBackdrop = true,
  closeOnEscape = true,
  variant,
  bodyClassName,
  bodyRef,
  children,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Ref-counted body scroll-lock while open.
  useEffect(() => {
    if (!open) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [open]);

  // Initial focus on open + restore focus to the opening element on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const body = card?.querySelector<HTMLElement>('.ui-modal-body');
    // Prefer the first focusable inside the body (e.g. a form field) over the
    // header close button; explicit initialFocusRef always wins.
    const target =
      initialFocusRef?.current ??
      body?.querySelector<HTMLElement>(FOCUSABLE) ??
      card?.querySelector<HTMLElement>(FOCUSABLE) ??
      card;
    target?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open, initialFocusRef]);

  // Escape to close + Tab focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeOnEscape) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={`ui-modal-backdrop${variant === 'perf' ? ' ui-modal-backdrop--perf' : ''}`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={cardRef}
        className={`ui-modal ui-modal--${size}${variant === 'perf' ? ' ui-modal--perf' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ui-modal-header">
          {icon && <span className="ui-modal-icon">{icon}</span>}
          <div className="ui-modal-titles">
            <span className="ui-modal-title" id={titleId}>{title}</span>
            {subtitle != null && <span className="ui-modal-subtitle">{subtitle}</span>}
          </div>
          {!hideClose && (
            <button
              type="button"
              className="ui-modal-close"
              onClick={onClose}
              aria-label={closeLabel ?? 'Close'}
              data-tooltip={closeLabel}
              data-tooltip-pos="bottom"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className={`ui-modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`} ref={bodyRef}>
          {children}
        </div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
