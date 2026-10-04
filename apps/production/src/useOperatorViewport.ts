import { useCallback, useEffect, useMemo, useState } from 'react';

interface ViewportSnapshot {
  width: number;
  height: number;
  touchCapable: boolean;
  landscape: boolean;
  phoneLandscape: boolean;
  tabletLandscape: boolean;
  portraitTouch: boolean;
}

const LANDSCAPE_HINT_KEY = 'musicscale.live.operator-landscape-hint.dismissed';

function readSnapshot(): ViewportSnapshot {
  const viewport = window.visualViewport;
  const width = Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0);
  const height = Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  const touchCapable = (navigator.maxTouchPoints || 0) > 0 || coarsePointer || noHover;
  const landscape = width > height;
  const operatorLandscape = touchCapable && landscape && width >= 640;

  return {
    width,
    height,
    touchCapable,
    landscape,
    phoneLandscape: operatorLandscape && height <= 520,
    tabletLandscape: operatorLandscape && height > 520,
    portraitTouch: touchCapable && !landscape && width <= 1100
  };
}

export function useOperatorViewport(enabled: boolean) {
  const [viewport, setViewport] = useState<ViewportSnapshot>(() => readSnapshot());
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(LANDSCAPE_HINT_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewport(readSnapshot()));
    };

    const visualViewport = window.visualViewport;
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('orientationchange', update);
    visualViewport?.addEventListener('resize', update, { passive: true });

    update();

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      visualViewport?.removeEventListener('resize', update);
    };
  }, [enabled]);

  const dismissLandscapeHint = useCallback(() => {
    setHintDismissed(true);
    try {
      sessionStorage.setItem(LANDSCAPE_HINT_KEY, '1');
    } catch {
      // Storage is optional; the operator workflow must remain functional without it.
    }
  }, []);

  const classes = useMemo(() => {
    if (!enabled) return [] as string[];
    const next: string[] = [];
    if (viewport.touchCapable) next.push('operator-touch');
    if (viewport.portraitTouch) next.push('operator-portrait');
    if (viewport.phoneLandscape || viewport.tabletLandscape) next.push('operator-landscape');
    if (viewport.phoneLandscape) next.push('operator-phone-landscape');
    if (viewport.tabletLandscape) next.push('operator-tablet-landscape');
    return next;
  }, [enabled, viewport]);

  return {
    ...viewport,
    classes,
    showLandscapeHint: enabled && viewport.portraitTouch && !hintDismissed,
    dismissLandscapeHint
  };
}
