import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Music2 } from 'lucide-react';

interface MusicFolder { id: string; name: string }

interface Props {
  filterId: string;
  selectedFolderName: string | null;
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: { top: number; left: number; width: number };
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
  musicFolders: MusicFolder[];
  pickLibrary: (id: 'all' | string) => void;
}

export default function SidebarLibraryPicker({
  filterId, selectedFolderName, libraryDropdownOpen, setLibraryDropdownOpen,
  dropdownRect, libraryTriggerRef, musicFolders, pickLibrary,
}: Props) {
  const { t } = useTranslation();
  const libraryTriggerPlain = filterId === 'all';
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const allLibrariesLabel = t('sidebar.allLibraries');

  useLayoutEffect(() => {
    if (!libraryDropdownOpen) {
      setPanelWidth(null);
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const minW = dropdownRect.width;
      const maxW = Math.max(minW, window.innerWidth - dropdownRect.left - 8);
      panel.dataset.measure = 'true';
      panel.style.width = 'max-content';
      panel.style.minWidth = `${minW}px`;
      const measured = panel.offsetWidth;
      delete panel.dataset.measure;
      panel.style.width = '';
      panel.style.minWidth = '';
      setPanelWidth(Math.min(Math.max(minW, measured), maxW));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [
    libraryDropdownOpen,
    dropdownRect.left,
    dropdownRect.width,
    musicFolders,
    allLibrariesLabel,
  ]);

  return (
    <>
      <button
        ref={libraryTriggerRef}
        type="button"
        className={`nav-library-scope-trigger ${libraryTriggerPlain ? 'nav-library-scope-trigger--plain' : ''} ${libraryDropdownOpen ? 'nav-library-scope-trigger--open' : ''}`}
        onClick={() => setLibraryDropdownOpen(!libraryDropdownOpen)}
        aria-label={t('sidebar.libraryScope')}
        aria-expanded={libraryDropdownOpen}
        aria-haspopup="listbox"
        data-tooltip={libraryDropdownOpen ? undefined : t('sidebar.libraryScope')}
        data-tooltip-pos="bottom"
      >
        {!libraryTriggerPlain ? (
          <Music2 size={16} className="nav-library-scope-icon" strokeWidth={2} aria-hidden />
        ) : null}
        <div className="nav-library-scope-text">
          <span className="nav-library-scope-title">{t('sidebar.library')}</span>
          {selectedFolderName ? (
            <span className="nav-library-scope-subtitle" data-tooltip={selectedFolderName} data-tooltip-pos="right">
              {selectedFolderName}
            </span>
          ) : null}
        </div>
        <ChevronDown size={16} strokeWidth={2.25} className="nav-library-scope-chevron" aria-hidden />
      </button>
      {libraryDropdownOpen &&
        createPortal(
          <div
            ref={panelRef}
            className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
            role="listbox"
            aria-label={t('sidebar.libraryScope')}
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              minWidth: dropdownRect.width,
              width: panelWidth ?? 'max-content',
              boxSizing: 'border-box',
            }}
          >
            <button
              type="button"
              role="option"
              aria-selected={filterId === 'all'}
              className={`nav-library-dropdown-item ${filterId === 'all' ? 'nav-library-dropdown-item--selected' : ''}`}
              onClick={() => pickLibrary('all')}
            >
              <span className="nav-library-dropdown-item-label">{t('sidebar.allLibraries')}</span>
              {filterId === 'all' ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
            </button>
            {musicFolders.map(f => (
              <button
                key={f.id}
                type="button"
                role="option"
                aria-selected={filterId === f.id}
                className={`nav-library-dropdown-item ${filterId === f.id ? 'nav-library-dropdown-item--selected' : ''}`}
                onClick={() => pickLibrary(f.id)}
              >
                <span className="nav-library-dropdown-item-label">{f.name}</span>
                {filterId === f.id ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
