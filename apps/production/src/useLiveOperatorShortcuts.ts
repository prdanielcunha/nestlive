import { useEffect, useRef } from 'react';

export interface LiveShortcutBindings {
  previous: string;
  next: string;
  take: string;
}

export const DEFAULT_LIVE_SHORTCUTS: LiveShortcutBindings = {
  previous: 'ArrowLeft',
  next: 'ArrowRight',
  take: ''
};

const STORAGE_KEY = 'nestlive:operator-shortcuts:v1';

export function loadLiveShortcutBindings(): LiveShortcutBindings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIVE_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<LiveShortcutBindings>;
    return {
      previous: typeof parsed.previous === 'string' ? parsed.previous : DEFAULT_LIVE_SHORTCUTS.previous,
      next: typeof parsed.next === 'string' ? parsed.next : DEFAULT_LIVE_SHORTCUTS.next,
      take: typeof parsed.take === 'string' ? parsed.take : DEFAULT_LIVE_SHORTCUTS.take
    };
  } catch {
    return { ...DEFAULT_LIVE_SHORTCUTS };
  }
}

export function saveLiveShortcutBindings(bindings: LiveShortcutBindings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Shortcut persistence is non-critical.
  }
}

interface LiveOperatorShortcutOptions {
  enabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onTake?: () => void;
  bindings?: LiveShortcutBindings;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      'input,textarea,select,button,[role="textbox"],[role="combobox"],[contenteditable="true"]'
    )
  );
}

/**
 * Operator shortcuts are deterministic, local and editable.
 * No key is allowed to bypass Preview/NEXT; an optional TAKE binding calls
 * the same guarded TAKE path as the visible control.
 */
export function useLiveOperatorShortcuts({
  enabled,
  onPrevious,
  onNext,
  onTake,
  bindings = DEFAULT_LIVE_SHORTCUTS
}: LiveOperatorShortcutOptions): void {
  const handlers = useRef({ onPrevious, onNext, onTake });

  useEffect(() => {
    handlers.current = { onPrevious, onNext, onTake };
  }, [onPrevious, onNext, onTake]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditingTarget(event.target)
      ) {
        return;
      }

      if (bindings.previous && event.key === bindings.previous) {
        event.preventDefault();
        handlers.current.onPrevious();
      } else if (bindings.next && event.key === bindings.next) {
        event.preventDefault();
        handlers.current.onNext();
      } else if (bindings.take && event.key === bindings.take && handlers.current.onTake) {
        event.preventDefault();
        handlers.current.onTake();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [bindings.next, bindings.previous, bindings.take, enabled]);
}
