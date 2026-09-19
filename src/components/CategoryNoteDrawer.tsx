import { forwardRef, type PointerEvent, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ConfirmDialog } from './ConfirmDialog';
import {
  getNoteSaveErrorMessage,
  NoteLoadError,
  runAfterSuccessfulNoteFlush,
  shouldSnapshotNoteOnExit,
  waitForNoteSave,
} from './noteExitGuard';
import { createId } from '../utils/id';
import { loadCategoryNoteRaw, saveCategoryNoteRaw } from '../utils/noteStorage';
import {
  appendByteBudgetHistory,
  ByteBudgetLruCache,
  createByteBudgetHistory,
  estimateDataUrlMemoryBytes,
  estimateRgbaPixelBytes,
  getCanvasBackingStoreSize,
  NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES,
  NOTE_UNDO_HISTORY_BUDGET_BYTES,
  popByteBudgetHistory,
  type ByteBudgetHistory,
} from './noteMemory';
import './CategoryNoteDrawer.css';
import { boundedNoteScale, noteSwipeDirection } from './noteGestures';

const UNCATEGORIZED = '\u672a\u5206\u985e';
const NOTE_COLORS = {
  blue: '#2563eb',
  red: '#dc2626',
  black: '#111827',
} as const;
const PEN_WIDTHS = [1, 2, 3] as const;
const MARKER_COLORS = { yellow: '#f4d949', green: '#67ce82', blue: '#6ebcf3' } as const;
const MARKER_WIDTHS = [14, 22, 30] as const;
const ERASER_WIDTHS = [10, 15, 30] as const;
const OVERSCROLL_LIMIT = 36;
const PAN_EDGE_BREATHING_ROOM = 18;
const noteImageCache = new ByteBudgetLruCache<string, HTMLImageElement>(NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);

type NoteColorKey = keyof typeof NOTE_COLORS;
type PenSize = (typeof PEN_WIDTHS)[number];
type EraserSize = (typeof ERASER_WIDTHS)[number];
type NoteTool = 'pen' | 'eraser' | 'marker';
type NoteLoadState = 'loading' | 'ready' | 'error';
type NotePaintState = 'loading' | 'ready' | 'error';
type NoteSaveQueueState = 'idle' | 'pending' | 'saved' | 'error';

type NotePage = {
  id: string;
  dataUrl: string;
  updatedAt: string;
};

type CategoryNote = {
  problemSetId: string;
  category: string;
  pages: NotePage[];
  currentPageIndex: number;
  updatedAt: string;
};

interface CategoryNoteProps {
  backgroundUrl?: string;
  pageAspect?: number;
  singlePage?: boolean;
  pageNavigation?: { hasPrevious: boolean; hasNext: boolean; onNavigate: (delta: -1 | 1) => void };
  onReady?: () => void;
  problemSetId?: string;
  category?: string;
  className?: string;
  onClose?: () => void;
}

export interface CategoryNotePanelHandle {
  flush: () => Promise<void>;
}

export interface CategoryNoteDrawerHandle {
  close: () => Promise<boolean>;
  flush: () => Promise<void>;
}

interface CategoryNoteDrawerProps extends CategoryNoteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const CategoryNoteDrawer = forwardRef<CategoryNoteDrawerHandle, CategoryNoteDrawerProps>(function CategoryNoteDrawer(
  { problemSetId, category, open, onOpenChange },
  ref,
) {
  const dragStartRef = useRef<number | null>(null);
  const panelRef = useRef<CategoryNotePanelHandle>(null);
  const drawerTransitionQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const closePromiseRef = useRef<Promise<boolean> | null>(null);
  const latestProblemSetIdRef = useRef(problemSetId);
  const latestCategoryRef = useRef(category);
  const [internalOpen, setInternalOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [panelProblemSetId, setPanelProblemSetId] = useState(problemSetId);
  const [panelCategory, setPanelCategory] = useState(category);
  const isOpen = open ?? internalOpen;
  latestProblemSetIdRef.current = problemSetId;
  latestCategoryRef.current = category;

  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const enqueuePanelTransition = (proceed: () => void): Promise<boolean> => {
    const execute = () => runAfterSuccessfulNoteFlush(
      () => panelRef.current?.flush() ?? Promise.resolve(),
      proceed,
    );
    const queued = drawerTransitionQueueRef.current.then(execute, execute);
    drawerTransitionQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const requestClose = (): Promise<boolean> => {
    if (closePromiseRef.current) return closePromiseRef.current;
    const pendingClose = enqueuePanelTransition(() => {
      setPanelProblemSetId(latestProblemSetIdRef.current);
      setPanelCategory(latestCategoryRef.current);
      setOpen(false);
    });
    closePromiseRef.current = pendingClose;
    void pendingClose.then(
      () => {
        if (closePromiseRef.current === pendingClose) closePromiseRef.current = null;
      },
      () => {
        if (closePromiseRef.current === pendingClose) closePromiseRef.current = null;
      },
    );
    return pendingClose;
  };

  useImperativeHandle(ref, () => ({
    close: requestClose,
    flush: async () => {
      await drawerTransitionQueueRef.current;
      await (panelRef.current?.flush() ?? Promise.resolve());
    },
  }));

  useEffect(() => {
    if (problemSetId === panelProblemSetId && category === panelCategory) return;
    void enqueuePanelTransition(
      () => {
        setPanelProblemSetId(latestProblemSetIdRef.current);
        setPanelCategory(latestCategoryRef.current);
      },
    );
  }, [category, panelCategory, panelProblemSetId, problemSetId]);

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    dragStartRef.current = event.clientX;
    setDragging(true);
    setDragOffset(0);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragStartRef.current === null) return;
    const delta = event.clientX - dragStartRef.current;
    setDragOffset(isOpen ? Math.max(0, Math.min(360, delta)) : Math.min(0, Math.max(-360, delta)));
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragStartRef.current === null) return;
    const delta = event.clientX - dragStartRef.current;
    if (isOpen && delta > 90) void requestClose();
    if (!isOpen && delta < -70) setOpen(true);
    dragStartRef.current = null;
    setDragging(false);
    setDragOffset(0);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  if (!problemSetId) return null;

  const drawerStyle = dragging
    ? { transform: isOpen ? `translateX(${dragOffset}px)` : `translateX(calc(100% + ${dragOffset}px))` }
    : undefined;

  return (
    <>
      <button
        type="button"
        className="category-note-tab"
        onClick={() => setOpen(true)}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {'\u30ce\u30fc\u30c8'}
      </button>
      <aside
        className={`category-note-drawer${isOpen ? ' category-note-drawer--open' : ''}${dragging ? ' category-note-drawer--dragging' : ''}`}
        style={drawerStyle}
      >
        <div
          className="category-note-drawer__handle"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <CategoryNotePanel
          ref={panelRef}
          problemSetId={panelProblemSetId}
          category={panelCategory}
          onClose={() => void requestClose()}
        />
      </aside>
    </>
  );
});

export const CategoryNotePanel = forwardRef<CategoryNotePanelHandle, CategoryNoteProps>(function CategoryNotePanel(
  { problemSetId, category, className = '', onClose, backgroundUrl, pageAspect = 210 / 297, singlePage = false, pageNavigation, onReady },
  ref,
) {
  const normalizedCategory = normalizeCategory(category);
  const noteKey = problemSetId ? getNoteKey(problemSetId, normalizedCategory) : '';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevPageRef = useRef<HTMLDivElement | null>(null);
  const nextPageRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const pendingResizeRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const historyRef = useRef<ByteBudgetHistory<string>>(createByteBudgetHistory());
  const pageSwipeRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ startDistance: number; startScale: number } | null>(null);
  const pagePanGestureRef = useRef<{ x: number; y: number; pointerId: number; startPan: { x: number; y: number } } | null>(null);
  const pageScaleRef = useRef(1);
  const pagePanRef = useRef({ x: 0, y: 0 });
  const pagePinchingRef = useRef(false);
  const pageElementRef = useRef<HTMLDivElement | null>(null);
  const pageSwipeFrameRef = useRef<number | null>(null);
  const pageSwipeOffsetRef = useRef(0);
  const pagePanFrameRef = useRef<number | null>(null);
  const activePageRef = useRef<HTMLDivElement | null>(null);
  const primaryTouchIdRef = useRef<number | null>(null);
  const pageDataUrlRef = useRef('');
  const toolRef = useRef<NoteTool>('pen');
  const markerStrokeRef = useRef<{ base: HTMLCanvasElement; points: { x: number; y: number }[] } | null>(null);
  const colorRef = useRef<string>(NOTE_COLORS.black);
  const widthRef = useRef<number>(1);
  const noteSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestNoteSaveIdRef = useRef(0);
  const pendingDrawSaveTimerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const flushingRef = useRef(false);
  const noteLoadPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const noteLoadStateRef = useRef<NoteLoadState>('loading');
  const noteLoadRequestIdRef = useRef(0);
  const renderedNoteKeyRef = useRef('');
  const renderedPageIdRef = useRef('');
  const notePaintPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const notePaintStateRef = useRef<NotePaintState>('loading');
  const notePaintRequestIdRef = useRef(0);
  const canvasDirtyRef = useRef(false);
  const noteSaveQueueStateRef = useRef<NoteSaveQueueState>('idle');
  const latestNoteSaveCandidateRef = useRef<{ noteKey: string; note: CategoryNote } | null>(null);

  const [note, setNote] = useState<CategoryNote>(() => createEmptyNote(problemSetId ?? '', normalizedCategory));
  const [pageIndex, setPageIndex] = useState(0);
  const [colorKey, setColorKey] = useState<NoteColorKey>('black');
  const [penSize, setPenSize] = useState<PenSize>(1);
  const [eraserSize, setEraserSize] = useState<EraserSize>(10);
  const [tool, setTool] = useState<NoteTool>('pen');
  const [markerColor, setMarkerColor] = useState<keyof typeof MARKER_COLORS>('yellow');
  const [markerSize, setMarkerSize] = useState<number>(22);
  const [canUndo, setCanUndo] = useState(false);
  const [pageSwiping, setPageSwiping] = useState(false);
  const [pageScale, setPageScaleState] = useState(1);
  const [pagePan, setPagePanState] = useState({ x: 0, y: 0 });
  const [pagePinching, setPagePinchingState] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [deletePageConfirmOpen, setDeletePageConfirmOpen] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);
  const [noteLoadState, setNoteLoadState] = useState<NoteLoadState>('loading');
  const [noteLoadError, setNoteLoadError] = useState('');
  const [notePaintState, setNotePaintState] = useState<NotePaintState>('loading');

  const getPagePanMetrics = (scale = pageScaleRef.current) => {
    const page = canvasRef.current?.parentElement as HTMLElement | null;
    const slot = page?.parentElement as HTMLElement | null;
    const pageWidth = page?.offsetWidth ?? 0;
    const pageHeight = page?.offsetHeight ?? 0;
    const viewportWidth = slot?.clientWidth ?? 0;
    const viewportHeight = slot?.clientHeight ?? 0;

    return {
      scaledPageWidth: pageWidth * scale,
      scaledPageHeight: pageHeight * scale,
      viewportWidth,
      viewportHeight,
    };
  };

  const clampAxisPan = (pan: number, pageSize: number, viewportSize: number, allowOverscroll = false) => {
    const overflow = Math.max(0, pageSize - viewportSize);
    if (overflow <= 0) return 0;
    const maxPan = overflow / 2;
    const overscroll = allowOverscroll ? OVERSCROLL_LIMIT : PAN_EDGE_BREATHING_ROOM;
    return Math.max(-maxPan - overscroll, Math.min(maxPan + overscroll, pan));
  };

  const clampPagePan = (nextPan: { x: number; y: number }, scale = pageScaleRef.current, allowOverscroll = false) => {
    const metrics = getPagePanMetrics(scale);
    return {
      x: clampAxisPan(nextPan.x, metrics.scaledPageWidth, metrics.viewportWidth, allowOverscroll),
      y: clampAxisPan(nextPan.y, metrics.scaledPageHeight, metrics.viewportHeight, allowOverscroll),
    };
  };

  const setPagePanValue = (nextPan: { x: number; y: number }, scale = pageScaleRef.current, allowOverscroll = false) => {
    if (pagePanFrameRef.current !== null) { cancelAnimationFrame(pagePanFrameRef.current); pagePanFrameRef.current = null; }
    const clamped = clampPagePan(nextPan, scale, allowOverscroll);
    pagePanRef.current = clamped;
    setPagePanState(clamped);
  };

  const setPagePanInteractive = (nextPan: { x: number; y: number }, scale = pageScaleRef.current, allowOverscroll = true) => {
    const clamped = clampPagePan(nextPan, scale, allowOverscroll);
    pagePanRef.current = clamped;
    if (pagePanFrameRef.current !== null) return;
    pagePanFrameRef.current = requestAnimationFrame(() => {
      pagePanFrameRef.current = null;
      setPagePanState({ ...pagePanRef.current });
      setPageScaleState(pageScaleRef.current);
    });
  };

  const resetPageView = () => {
    if (pagePanFrameRef.current !== null) {
      cancelAnimationFrame(pagePanFrameRef.current);
      pagePanFrameRef.current = null;
    }
    pageScaleRef.current = 1;
    pagePanRef.current = { x: 0, y: 0 };
    setPageScaleState(1);
    setPagePanState({ x: 0, y: 0 });
    setPagePinchingValue(false);
  };

  const setPageScaleValue = (nextScale: number, elastic = false) => {
    const normalizedScale = boundedNoteScale(nextScale, elastic);
    pageScaleRef.current = normalizedScale;
    const nextPan = normalizedScale <= 1 ? { x: 0, y: 0 } : pagePanRef.current;
    if (elastic) setPagePanInteractive(nextPan, normalizedScale, false);
    else { setPageScaleState(normalizedScale); setPagePanValue(nextPan, normalizedScale); }
  };

  const setPagePinchingValue = (nextPinching: boolean) => {
    pagePinchingRef.current = nextPinching;
    setPagePinchingState(nextPinching);
  };

  const resetTouchGesture = () => {
    touchPointsRef.current.clear();
    primaryTouchIdRef.current = null;
    pageSwipeRef.current = null;
    pagePanGestureRef.current = null;
    pinchRef.current = null;
    setPagePinchingValue(false);
    setPageScaleValue(pageScaleRef.current);
  };

  useEffect(() => () => {
    if (pagePanFrameRef.current !== null) cancelAnimationFrame(pagePanFrameRef.current);
    if (pageSwipeFrameRef.current !== null) cancelAnimationFrame(pageSwipeFrameRef.current);
  }, []);
  useEffect(() => { if (noteLoadState === 'ready' && notePaintState === 'ready') onReady?.(); }, [noteLoadState, notePaintState, onReady]);

  const pages = note.pages.length > 0 ? note.pages : [createBlankPage()];
  const currentPageIndex = Math.min(pageIndex, pages.length - 1);
  const currentPage = pages[currentPageIndex] ?? pages[0];
  const activeWidth = tool === 'eraser' ? eraserSize : tool === 'marker' ? markerSize : penSize;
  const activeWidths = tool === 'eraser' ? ERASER_WIDTHS : tool === 'marker' ? MARKER_WIDTHS : PEN_WIDTHS;
  const noteInteractionDisabled = isFlushing || noteLoadState !== 'ready' || notePaintState !== 'ready';
  const saveStatusText = noteLoadState === 'loading' || notePaintState === 'loading'
    ? '読み込み中'
    : noteLoadState === 'error' || notePaintState === 'error'
      ? '読み込み失敗'
      : saveState === 'error' ? '保存失敗' : '';

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = tool === 'marker' ? MARKER_COLORS[markerColor] : NOTE_COLORS[colorKey];
  }, [colorKey, markerColor, tool]);

  useEffect(() => {
    widthRef.current = activeWidth;
  }, [activeWidth]);

  const startNoteLoad = () => {
    const requestId = noteLoadRequestIdRef.current + 1;
    noteLoadRequestIdRef.current = requestId;
    renderedNoteKeyRef.current = '';
    renderedPageIdRef.current = '';
    notePaintRequestIdRef.current += 1;
    notePaintStateRef.current = 'loading';
    setNotePaintState('loading');
    canvasDirtyRef.current = false;
    noteLoadStateRef.current = 'loading';
    setNoteLoadState('loading');
    setNoteLoadError('');
    setSaveState('idle');
    setSaveError('');

    if (!problemSetId || !noteKey) {
      noteLoadStateRef.current = 'ready';
      setNoteLoadState('ready');
      const pending = Promise.resolve();
      noteLoadPromiseRef.current = pending;
      return { requestId, pending };
    }

    const pending = loadCategoryNoteRaw(noteKey)
      .then((raw) => {
        if (noteLoadRequestIdRef.current !== requestId) return;
        const loaded = parseNote(raw, problemSetId, normalizedCategory);
        setNote(loaded);
        setPageIndex(Math.min(loaded.currentPageIndex, Math.max(loaded.pages.length - 1, 0)));
        clearHistory();
        noteLoadStateRef.current = 'ready';
        setNoteLoadState('ready');
      })
      .catch((error) => {
        if (noteLoadRequestIdRef.current !== requestId) return;
        console.warn('Failed to load category note.', error);
        const loadError = new NoteLoadError();
        noteLoadStateRef.current = 'error';
        setNoteLoadState('error');
        setNoteLoadError(getNoteSaveErrorMessage(loadError));
        throw loadError;
      });
    noteLoadPromiseRef.current = pending;
    void pending.catch(() => undefined);
    return { requestId, pending };
  };

  useEffect(() => {
    const { requestId } = startNoteLoad();

    return () => {
      if (noteLoadRequestIdRef.current === requestId) noteLoadRequestIdRef.current += 1;
    };
  }, [problemSetId, noteKey, normalizedCategory]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || noteLoadState !== 'ready') return;

    pageDataUrlRef.current = currentPage?.dataUrl ?? '';

    const setupCanvas = (forceDraw = false) => {
      const { width, height } = getCanvasLogicalSize(canvas);
      if (width === 0 || height === 0) return;
      if (drawingRef.current || canvasDirtyRef.current) {
        pendingResizeRef.current = true;
        return;
      }

      const backingStore = getCanvasBackingStoreSize(width, height, window.devicePixelRatio || 1);
      const sizeChanged = canvas.width !== backingStore.width || canvas.height !== backingStore.height;
      if (sizeChanged || forceDraw) {
        drawDataUrlToCanvas(pageDataUrlRef.current, currentPage?.id ?? '');
      }
    };

    setupCanvas(true);
    const observer = new ResizeObserver(() => setupCanvas(false));
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      notePaintRequestIdRef.current += 1;
    };
  }, [currentPage?.id, noteKey, noteLoadState]);

  const snapshot = () => canvasRef.current?.toDataURL('image/png') ?? '';

  const persistNote = (nextNote: CategoryNote, targetNoteKey = noteKey): Promise<void> => {
    if (!targetNoteKey) return Promise.resolve();

    const raw = JSON.stringify(nextNote);
    const saveId = latestNoteSaveIdRef.current + 1;
    latestNoteSaveIdRef.current = saveId;
    latestNoteSaveCandidateRef.current = { noteKey: targetNoteKey, note: nextNote };
    noteSaveQueueStateRef.current = 'pending';
    setSaveState('saving');
    setSaveError('');

    const queuedSave = noteSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveCategoryNoteRaw(targetNoteKey, raw));
    noteSaveQueueRef.current = queuedSave;

    void queuedSave
      .then(() => {
        if (latestNoteSaveIdRef.current === saveId) {
          noteSaveQueueStateRef.current = 'saved';
          setSaveState('saved');
          setSaveError('');
        }
      })
      .catch((error) => {
        if (latestNoteSaveIdRef.current !== saveId) return;
        console.warn('Failed to save category note.', error);
        noteSaveQueueStateRef.current = 'error';
        setSaveState('error');
        setSaveError(getNoteSaveErrorMessage(error));
      });

    return queuedSave;
  };
  const updateCurrentPage = (dataUrl = snapshot(), nextIndex = currentPageIndex) => {
    if (!problemSetId || !dataUrl) return note;
    const nextPages = [...pages];
    nextPages[nextIndex] = { ...nextPages[nextIndex], dataUrl, updatedAt: new Date().toISOString() };
    const nextNote: CategoryNote = {
      problemSetId,
      category: normalizedCategory,
      pages: nextPages,
      currentPageIndex: nextIndex,
      updatedAt: new Date().toISOString(),
    };
    pageDataUrlRef.current = dataUrl;
    canvasDirtyRef.current = false;
    setNote(nextNote);
    setPageIndex(nextIndex);
    persistNote(nextNote);
    return nextNote;
  };

  const flushPendingNote = (): Promise<void> => {
    if (flushPromiseRef.current) return flushPromiseRef.current;

    const pendingFlush = (async () => {
      flushingRef.current = true;
      setIsFlushing(true);
      setSaveError('');
      let failurePhase: 'load' | 'paint' | 'save' = 'load';

      try {
        if (noteLoadStateRef.current === 'error') {
          await waitForNoteSave(startNoteLoad().pending);
        } else if (noteLoadStateRef.current === 'loading') {
          await waitForNoteSave(noteLoadPromiseRef.current);
        }
        if (noteLoadStateRef.current !== 'ready') throw new NoteLoadError();

        if (pendingDrawSaveTimerRef.current !== null) {
          window.clearTimeout(pendingDrawSaveTimerRef.current);
          pendingDrawSaveTimerRef.current = null;
        }
        drawingRef.current = false;
        lastPointRef.current = null;

        if (canvasDirtyRef.current) {
          failurePhase = 'paint';
          if (notePaintStateRef.current === 'loading') {
            await waitForNoteSave(notePaintPromiseRef.current);
          }
          if (!shouldSnapshotNoteOnExit({
            dirty: canvasDirtyRef.current,
            loadReady: noteLoadStateRef.current === 'ready',
            paintReady: notePaintStateRef.current === 'ready',
            renderedNoteMatches: renderedNoteKeyRef.current === noteKey,
            renderedPageMatches: renderedPageIdRef.current === (currentPage?.id ?? ''),
          })) {
            throw new NoteLoadError();
          }
          updateCurrentPage();
        }

        failurePhase = 'save';
        if (noteSaveQueueStateRef.current === 'error') {
          const retryCandidate = latestNoteSaveCandidateRef.current;
          if (retryCandidate) persistNote(retryCandidate.note, retryCandidate.noteKey);
        }
        await waitForNoteSave(noteSaveQueueRef.current);
        if (noteSaveQueueStateRef.current !== 'idle') setSaveState('saved');
      } catch (error) {
        console.warn('Failed to save category note before leaving.', error);
        if (failurePhase === 'load' || failurePhase === 'paint') {
          if (failurePhase === 'load' && noteLoadStateRef.current === 'loading') {
            noteLoadRequestIdRef.current += 1;
            noteLoadStateRef.current = 'error';
            setNoteLoadState('error');
          }
          if (failurePhase === 'paint') {
            notePaintRequestIdRef.current += 1;
            notePaintStateRef.current = 'error';
            setNotePaintState('error');
          }
          const message = error instanceof NoteLoadError
            ? getNoteSaveErrorMessage(error)
            : 'ノートの準備に時間がかっています。もう一度お試しください。';
          setNoteLoadError(message);
        } else {
          setSaveState('error');
          setSaveError(getNoteSaveErrorMessage(error));
        }
        throw error;
      } finally {
        flushingRef.current = false;
        setIsFlushing(false);
      }
    })();

    flushPromiseRef.current = pendingFlush;
    void pendingFlush.then(
      () => {
        if (flushPromiseRef.current === pendingFlush) flushPromiseRef.current = null;
      },
      () => {
        if (flushPromiseRef.current === pendingFlush) flushPromiseRef.current = null;
      },
    );
    return pendingFlush;
  };

  useImperativeHandle(ref, () => ({ flush: flushPendingNote }));

  function clearHistory() {
    historyRef.current = createByteBudgetHistory();
    setCanUndo(false);
  }

  const markCanvasPaintPending = () => {
    notePaintRequestIdRef.current += 1;
    renderedNoteKeyRef.current = '';
    renderedPageIdRef.current = '';
    notePaintStateRef.current = 'loading';
    setNotePaintState('loading');
  };

  const pushHistory = () => {
    const image = snapshot();
    if (!image) return;
    historyRef.current = appendByteBudgetHistory(
      historyRef.current,
      image,
      estimateDataUrlMemoryBytes(image),
      NOTE_UNDO_HISTORY_BUDGET_BYTES,
    );
    setCanUndo(historyRef.current.entries.length > 0);
  };

  const undo = () => {
    if (flushingRef.current || noteLoadStateRef.current !== 'ready' || notePaintStateRef.current !== 'ready') return;
    const popped = popByteBudgetHistory(historyRef.current);
    const previous = popped.value;
    if (!previous) return;
    historyRef.current = popped.history;
    setCanUndo(historyRef.current.entries.length > 0);
    drawDataUrlToCanvas(previous);
    updateCurrentPage(previous);
  };

  const addPage = (position: 'before' | 'after') => {
    if (flushingRef.current || noteLoadStateRef.current !== 'ready' || notePaintStateRef.current !== 'ready') return;
    const saved = updateCurrentPage();
    const insertionIndex = position === 'before' ? currentPageIndex : currentPageIndex + 1;
    const nextPages = [...saved.pages];
    nextPages.splice(insertionIndex, 0, createBlankPage());
    const nextIndex = insertionIndex;
    const nextNote: CategoryNote = {
      problemSetId: problemSetId ?? '',
      category: normalizedCategory,
      pages: nextPages,
      currentPageIndex: nextIndex,
      updatedAt: new Date().toISOString(),
    };
    pageDataUrlRef.current = '';
    markCanvasPaintPending();
    setNote(nextNote);
    setPageIndex(nextIndex);
    resetPageView();
    clearHistory();
    persistNote(nextNote);
  };

  const deletePage = () => {
    if (flushingRef.current || noteLoadStateRef.current !== 'ready' || notePaintStateRef.current !== 'ready') return;
    if (pages.length <= 1) return;
    setDeletePageConfirmOpen(true);
  };

  const confirmDeletePage = () => {
    if (flushingRef.current || noteLoadStateRef.current !== 'ready' || notePaintStateRef.current !== 'ready') return;
    setDeletePageConfirmOpen(false);
    if (pages.length <= 1) return;
    const saved = updateCurrentPage();
    const nextPages = saved.pages.filter((_, index) => index !== currentPageIndex);
    const nextIndex = Math.min(currentPageIndex, nextPages.length - 1);
    const nextNote: CategoryNote = {
      problemSetId: problemSetId ?? '',
      category: normalizedCategory,
      pages: nextPages,
      currentPageIndex: nextIndex,
      updatedAt: new Date().toISOString(),
    };
    pageDataUrlRef.current = nextPages[nextIndex]?.dataUrl ?? '';
    markCanvasPaintPending();
    setNote(nextNote);
    setPageIndex(nextIndex);
    resetPageView();
    clearHistory();
    persistNote(nextNote);
  };

  const goToPage = (nextIndex: number) => {
    if (flushingRef.current || noteLoadStateRef.current !== 'ready' || notePaintStateRef.current !== 'ready') return;
    if (nextIndex < 0 || nextIndex >= pages.length) return;
    const saved = updateCurrentPage();
    const nextNote = { ...saved, currentPageIndex: nextIndex, updatedAt: new Date().toISOString() };
    pageDataUrlRef.current = nextNote.pages[nextIndex]?.dataUrl ?? '';
    markCanvasPaintPending();
    setNote(nextNote);
    setPageIndex(nextIndex);
    resetPageView();
    clearHistory();
    persistNote(nextNote);
  };

  const beginPageSwipe = (event: PointerEvent<HTMLCanvasElement>) => {
    if (
      flushingRef.current
      || noteLoadStateRef.current !== 'ready'
      || notePaintStateRef.current !== 'ready'
      || renderedNoteKeyRef.current !== noteKey
      || renderedPageIdRef.current !== (currentPage?.id ?? '')
    ) return;
    if (event.pointerType !== 'touch') return;
    if (drawingRef.current) return;
    event.preventDefault();
    if (touchPointsRef.current.size >= 2 && !touchPointsRef.current.has(event.pointerId)) return;
    if (touchPointsRef.current.size === 0) {
      if (isPalmLikeTouch(event)) return;
      primaryTouchIdRef.current = event.pointerId;
    }
    touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (touchPointsRef.current.size >= 2) {
      if (pinchRef.current) return;
      pageSwipeRef.current = null;
      pagePanGestureRef.current = null;
      setPageSwiping(false);
      resetPageRail();
      const points = Array.from(touchPointsRef.current.values()).slice(0, 2);
      pinchRef.current = { startDistance: getPointDistance(points[0], points[1]), startScale: pageScaleRef.current };
      setPagePinchingValue(true);
      return;
    }

    if (pageScaleRef.current > 1.02) {
      pageSwipeRef.current = null;
      pagePanGestureRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        startPan: pagePanRef.current,
      };
      setPageSwiping(false);
      setPagePinchingValue(true);
      return;
    }

    pageSwipeRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    setPageSwiping(true);
    setPageTransform(0);
  };

  const movePageSwipe = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointsRef.current.size >= 2 && !pinchRef.current) {
        pageSwipeRef.current = null;
        pagePanGestureRef.current = null;
        setPageSwiping(false);
        resetPageRail();
        const startPoints = Array.from(touchPointsRef.current.values()).slice(0, 2);
        pinchRef.current = { startDistance: getPointDistance(startPoints[0], startPoints[1]), startScale: pageScaleRef.current };
        setPagePinchingValue(true);
      }
      if (pinchRef.current && touchPointsRef.current.size >= 2) {
        event.preventDefault();
        const points = Array.from(touchPointsRef.current.values()).slice(0, 2);
        const nextDistance = getPointDistance(points[0], points[1]);
        const nextScale = pinchRef.current.startScale * (nextDistance / Math.max(pinchRef.current.startDistance, 1));
        setPageScaleValue(nextScale, true);
        return;
      }
    }
    const pan = pagePanGestureRef.current;
    if (pan && pan.pointerId === event.pointerId && pageScaleRef.current > 1.02) {
      event.preventDefault();
      setPagePinchingValue(true);
      setPagePanInteractive({
        x: pan.startPan.x + event.clientX - pan.x,
        y: pan.startPan.y + event.clientY - pan.y,
      }, pageScaleRef.current, true);
      return;
    }

    const swipe = pageSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - swipe.x;
    const deltaY = event.clientY - swipe.y;
    if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      event.preventDefault();
      const limit = canvasRef.current?.clientWidth ?? 240;
      const hasPage = deltaX < 0 ? (pageNavigation?.hasNext ?? currentPageIndex < pages.length - 1) : (pageNavigation?.hasPrevious ?? currentPageIndex > 0);
      setPageTransform(Math.max(-limit, Math.min(limit, deltaX * (hasPage ? 1 : 0.18))));
    }
  };

  const setPageTransform = (offset: number) => {
    pageSwipeOffsetRef.current = offset;
    if (pageSwipeFrameRef.current !== null) cancelAnimationFrame(pageSwipeFrameRef.current);
    pageSwipeFrameRef.current = requestAnimationFrame(() => {
      pageSwipeFrameRef.current = null;
      if (!pageElementRef.current) return;
      pageElementRef.current.style.transform = offset === 0 ? 'translate3d(-33.333333%, 0, 0)' : `translate3d(calc(-33.333333% + ${offset}px), 0, 0)`;
    });
  };
  const endPageSwipe = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      if (event.type === 'pointerleave' && touchPointsRef.current.has(event.pointerId)) return;
      touchPointsRef.current.delete(event.pointerId);
      if (primaryTouchIdRef.current === event.pointerId) primaryTouchIdRef.current = null;
      if (pinchRef.current || pagePinchingRef.current) {
        if (touchPointsRef.current.size < 2) {
          pinchRef.current = null;
          setPagePinchingValue(false);
          setPageScaleValue(pageScaleRef.current);
          pagePanGestureRef.current = null;
          // One finger remaining after a pinch may pan, but never turn a page.
          const remaining = touchPointsRef.current.entries().next().value;
          if (remaining && pageScaleRef.current > 1.02) {
            pagePanGestureRef.current = { pointerId: remaining[0], x: remaining[1].x, y: remaining[1].y, startPan: { ...pagePanRef.current } };
          }
        }
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        return;
      }
    }
    const pan = pagePanGestureRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      pagePanGestureRef.current = null;
      setPagePinchingValue(false);
      setPagePanValue(pagePanRef.current, pageScaleRef.current, false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }

    const swipe = pageSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }
    const deltaX = event.clientX - swipe.x;
    const deltaY = event.clientY - swipe.y;
    const direction = noteSwipeDirection(deltaX, deltaY, event.type === 'pointercancel');
    pageSwipeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (pageNavigation) {
      setPageSwiping(false);
      // The parent owns PDF/blank page IDs and handles the guarded transition.
      resetPageRail();
      if ((direction === 1 && pageNavigation.hasNext) || (direction === -1 && pageNavigation.hasPrevious)) pageNavigation.onNavigate(direction);
      return;
    }
    if (direction === 1 && currentPageIndex < pages.length - 1) {
      animatePageCommit('next', currentPageIndex + 1);
      return;
    }
    if (direction === -1 && currentPageIndex > 0) {
      animatePageCommit('prev', currentPageIndex - 1);
      return;
    }

    setPageSwiping(false);
    resetPageRail();
  };

  const resetPageRail = () => {
    pageSwipeOffsetRef.current = 0;
    if (pageSwipeFrameRef.current !== null) {
      cancelAnimationFrame(pageSwipeFrameRef.current);
      pageSwipeFrameRef.current = null;
    }
    if (pageElementRef.current) {
      pageElementRef.current.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';
      pageElementRef.current.style.transform = 'translate3d(-33.333333%, 0, 0)';
      pageElementRef.current.style.opacity = '';
      window.setTimeout(() => {
        if (pageElementRef.current) pageElementRef.current.style.transition = '';
      }, 190);
    }
    if (prevPageRef.current) prevPageRef.current.style.opacity = '';
    if (nextPageRef.current) nextPageRef.current.style.opacity = '';
  };
  const animatePageCommit = (direction: 'prev' | 'next', targetIndex: number) => {
    const rail = pageElementRef.current;
    if (!rail) {
      goToPage(targetIndex);
      return;
    }

    const dataUrl = snapshot();
    const nextPages = [...pages];
    if (dataUrl) {
      nextPages[currentPageIndex] = { ...nextPages[currentPageIndex], dataUrl, updatedAt: new Date().toISOString() };
    }
    const nextNote: CategoryNote = {
      problemSetId: problemSetId ?? '',
      category: normalizedCategory,
      pages: nextPages,
      currentPageIndex: targetIndex,
      updatedAt: new Date().toISOString(),
    };
    canvasDirtyRef.current = false;
    persistNote(nextNote);
    preloadNoteImage(nextPages[targetIndex]?.dataUrl ?? '');

    const finishCommit = () => {
      rail.removeEventListener('transitionend', finishCommit);
      pageDataUrlRef.current = nextPages[targetIndex]?.dataUrl ?? '';
      resetTouchGesture();
      resetPageView();
      rail.style.transition = 'none';
      rail.style.transform = 'translate3d(-33.333333%, 0, 0)';
      markCanvasPaintPending();
      flushSync(() => {
        setNote(nextNote);
        setPageIndex(targetIndex);
        clearHistory();
      });
      drawDataUrlToCanvas(pageDataUrlRef.current, nextPages[targetIndex]?.id ?? '');
      void rail.offsetHeight;
      rail.style.transition = '';
    };

    if (pageSwipeFrameRef.current !== null) {
      cancelAnimationFrame(pageSwipeFrameRef.current);
      pageSwipeFrameRef.current = null;
    }

    const currentOffset = pageSwipeOffsetRef.current;
    rail.style.transition = 'none';
    rail.style.transform = currentOffset === 0 ? 'translate3d(-33.333333%, 0, 0)' : `translate3d(calc(-33.333333% + ${currentOffset}px), 0, 0)`;
    void rail.offsetHeight;

    rail.addEventListener('transitionend', finishCommit, { once: true });
    setPageSwiping(false);
    rail.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
    requestAnimationFrame(() => {
      rail.style.transform = direction === 'next' ? 'translate3d(-66.666667%, 0, 0)' : 'translate3d(0, 0, 0)';
    });
  };
  const beginDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (
      flushingRef.current
      || noteLoadStateRef.current !== 'ready'
      || notePaintStateRef.current !== 'ready'
      || renderedNoteKeyRef.current !== noteKey
      || renderedPageIdRef.current !== (currentPage?.id ?? '')
    ) return;
    if (!canDraw(event)) {
      beginPageSwipe(event);
      return;
    }
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    pushHistory();
    drawingRef.current = true;
    pendingResizeRef.current = false;
    lastPointRef.current = getCanvasPoint(canvas, event);
    markerStrokeRef.current = null;
    if (toolRef.current === 'marker') {
      const base = document.createElement('canvas'); base.width = canvas.width; base.height = canvas.height;
      base.getContext('2d')?.drawImage(canvas, 0, 0);
      markerStrokeRef.current = { base, points: [lastPointRef.current] };
    }
    canvas.setPointerCapture?.(event.pointerId);
  };

  const moveDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !canDraw(event)) {
      movePageSwipe(event);
      return;
    }
    event.preventDefault();
    const canvas = canvasRef.current;
    const lastPoint = lastPointRef.current;
    const context = ctxRef.current ?? canvas?.getContext('2d');
    if (!canvas || !lastPoint || !context) return;
    ctxRef.current = context;
    const nextPoint = getCanvasPoint(canvas, event);
    const drawingTool = toolRef.current;

    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = widthRef.current;
    context.strokeStyle = drawingTool === 'eraser' ? '#ffffff' : colorRef.current;
    if (singlePage && drawingTool === 'eraser') context.globalCompositeOperation = 'destination-out';
    const marker = drawingTool === 'marker' ? markerStrokeRef.current : null;
    if (marker) {
      // Repaint the whole stroke once per frame: slow movement must not leave
      // darker overlapping dots. The original PDF remains a separate layer.
      context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(marker.base, 0, 0); context.restore();
      context.globalAlpha = 0.38;
      context.globalCompositeOperation = 'multiply';
      marker.points.push(nextPoint);
    }
    context.beginPath();
    if (marker) {
      context.moveTo(marker.points[0].x, marker.points[0].y);
      for (const point of marker.points.slice(1)) context.lineTo(point.x, point.y);
    } else {
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(nextPoint.x, nextPoint.y);
    }
    context.stroke();
    context.restore();
    canvasDirtyRef.current = true;
    lastPointRef.current = nextPoint;
  };

  const endDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pageSwipeRef.current || pinchRef.current || pagePinchingRef.current || touchPointsRef.current.has(event.pointerId)) {
      endPageSwipe(event);
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    markerStrokeRef.current = null;
    lastPointRef.current = null;
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
    pendingDrawSaveTimerRef.current = window.setTimeout(() => {
      pendingDrawSaveTimerRef.current = null;
      updateCurrentPage();
      if (pendingResizeRef.current) {
        pendingResizeRef.current = false;
        redrawCanvasFromCurrentImage();
      }
    }, 0);
  };

  function drawDataUrlToCanvas(dataUrl: string, targetPageId = currentPage?.id ?? '') {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = getCanvasLogicalSize(canvas);
    if (width === 0 || height === 0) return;
    const paintRequestId = notePaintRequestIdRef.current + 1;
    notePaintRequestIdRef.current = paintRequestId;
    renderedNoteKeyRef.current = '';
    renderedPageIdRef.current = '';
    notePaintStateRef.current = 'loading';
    setNotePaintState('loading');
    const backingStore = getCanvasBackingStoreSize(width, height, window.devicePixelRatio || 1);
    if (canvas.width !== backingStore.width || canvas.height !== backingStore.height) {
      canvas.width = backingStore.width;
      canvas.height = backingStore.height;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      notePaintStateRef.current = 'error';
      setNotePaintState('error');
      setNoteLoadError('ノートを表示できませんでした。もう一度お試しください。');
      return;
    }
    ctxRef.current = context;
    context.setTransform(backingStore.scaleX, 0, 0, backingStore.scaleY, 0, 0);
    const pendingPaint = drawDataUrlToContext(
      context,
      dataUrl,
      width,
      height,
      () => notePaintRequestIdRef.current === paintRequestId,
      singlePage,
    );
    notePaintPromiseRef.current = pendingPaint;
    void pendingPaint.then(
      () => {
        if (notePaintRequestIdRef.current !== paintRequestId) return;
        renderedNoteKeyRef.current = noteKey;
        renderedPageIdRef.current = targetPageId;
        notePaintStateRef.current = 'ready';
        setNotePaintState('ready');
        setNoteLoadError('');
      },
      (error) => {
        if (notePaintRequestIdRef.current !== paintRequestId) return;
        console.warn('Failed to decode category note image.', error);
        notePaintStateRef.current = 'error';
        setNotePaintState('error');
        setNoteLoadError('ノートを表示できませんでした。もう一度お試しください。');
      },
    );
  }

  const redrawCanvasFromCurrentImage = () => {
    drawDataUrlToCanvas(pageDataUrlRef.current);
  };

  const selectColor = (key: NoteColorKey) => {
    setColorKey(key);
    setTool('pen');
  };

  return (
    <section
      className={`category-note-panel${singlePage ? ' category-note-panel--material' : ''}${isFlushing ? ' category-note-panel--flushing' : ''} ${className}`.trim()}
      aria-busy={isFlushing}
    >
      <header className="category-note-drawer__header">
        <div className="category-note-drawer__title-block">
          <p>{'\u30ce\u30fc\u30c8'}</p>
          <div className="category-note-drawer__title-row">
            <h2>{singlePage ? '書き込み' : normalizedCategory}</h2>
            <span>{'\u30da\u30fc\u30b8'} {currentPageIndex + 1} / {pages.length}</span>
            {saveStatusText ? (
              <span
                className={`category-note-save-state category-note-save-state--${noteLoadState === 'error' || notePaintState === 'error' ? 'error' : noteLoadState === 'loading' || notePaintState === 'loading' ? 'saving' : saveState}`}
                title={noteLoadError || saveError || saveStatusText}
              >
                {saveStatusText}
              </span>
            ) : null}
          </div>
        </div>
        <div className="category-note-drawer__header-actions" hidden={singlePage}>
          <button type="button" disabled={noteInteractionDisabled} onClick={() => addPage('before')}>{'前に追加'}</button>
          <button type="button" disabled={noteInteractionDisabled} onClick={() => addPage('after')}>{'後ろに追加'}</button>
          <button type="button" className="category-note-drawer__danger-button" disabled={noteInteractionDisabled || pages.length <= 1} onClick={deletePage}>{'\u524a\u9664'}</button>
          {onClose ? (
            <button type="button" disabled={isFlushing} aria-busy={isFlushing} onClick={onClose}>
              {isFlushing ? '\u4fdd\u5b58\u4e2d\u2026' : '\u9589\u3058\u308b'}
            </button>
          ) : null}
        </div>
      </header>

      {noteLoadError || saveError ? (
        <div className="category-note-save-error" role="alert">
          <span>{noteLoadError || saveError}</span>
          {noteLoadState === 'error' || notePaintState === 'error' ? (
            <button type="button" disabled={isFlushing} onClick={() => void startNoteLoad().pending.catch(() => undefined)}>
              再読み込み
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="category-note-canvas-area">
        <div className="category-note-page-viewport">
          <div
            ref={pageElementRef}
            className={`category-note-page-rail${pageSwiping ? ' category-note-page-rail--swiping' : ''}`}
            aria-label="A4 note page slider"
          >
            <div className="category-note-page-slot" aria-hidden="true">
              <div
                ref={prevPageRef}
                className={`category-note-page category-note-page--preview${!(pageNavigation?.hasPrevious ?? currentPageIndex > 0) ? ' category-note-page--missing' : ''}`}
                style={{ backgroundImage: pages[currentPageIndex - 1]?.dataUrl ? `url(${pages[currentPageIndex - 1].dataUrl})` : undefined }}
              />
            </div>
            <div className="category-note-page-slot">
              <div
                ref={activePageRef}
                className={`category-note-page category-note-page--active${pagePinching ? ' category-note-page--pinching' : ''}`}
                style={{ aspectRatio: pageAspect, width: singlePage ? `min(100%, ${pageAspect * 100}cqh)` : undefined, backgroundImage: backgroundUrl ? `url(${backgroundUrl})` : undefined, backgroundSize: '100% 100%', transform: pageScale === 1 ? undefined : `translate3d(${pagePan.x}px, ${pagePan.y}px, 0) scale(${pageScale})` }}
              >
                <canvas
                  ref={canvasRef}
                  className="category-note-canvas"
                  aria-disabled={noteInteractionDisabled}
                  onPointerDown={beginDraw}
                  onPointerMove={moveDraw}
                  onPointerUp={endDraw}
                  onPointerCancel={endDraw}
                  onPointerLeave={endDraw}
                />
              </div>
            </div>
            <div className="category-note-page-slot" aria-hidden="true">
              <div
                ref={nextPageRef}
                className={`category-note-page category-note-page--preview${!(pageNavigation?.hasNext ?? currentPageIndex < pages.length - 1) ? ' category-note-page--missing' : ''}`}
                style={{ backgroundImage: pages[currentPageIndex + 1]?.dataUrl ? `url(${pages[currentPageIndex + 1].dataUrl})` : undefined }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="category-note-toolbar" aria-label="note tools">
        <div className="category-note-tool-group" aria-label="表示倍率">
          <button type="button" aria-label="縮小" disabled={pageScale <= 1} onClick={() => setPageScaleValue(pageScale - 0.25)}>−</button>
          <button type="button" aria-label="倍率をリセット" onClick={resetPageView}>{Math.round(pageScale * 100)}%</button>
          <button type="button" aria-label="拡大" disabled={pageScale >= 2.5} onClick={() => setPageScaleValue(pageScale + 0.25)}>＋</button>
        </div>
        <div className="category-note-tool-group">
          <span>{'\u592a\u3055'}</span>
          {activeWidths.map((item) => (
            <button
              key={item}
              type="button"
              disabled={noteInteractionDisabled}
              className={activeWidth === item ? 'is-active' : ''}
              onClick={() => {
                if (tool === 'eraser') setEraserSize(item as EraserSize);
                else if (tool === 'marker') setMarkerSize(item);
                else setPenSize(item as PenSize);
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="category-note-tool-group category-note-tool-group--tools">
          <span>ペン</span>
          {(Object.keys(NOTE_COLORS) as NoteColorKey[]).map((key) => (
            <button
              key={key}
              type="button"
              disabled={noteInteractionDisabled}
              className={`category-note-color category-note-color--${key}${colorKey === key && tool === 'pen' ? ' is-active' : ''}`}
              aria-label={key}
              title={key}
              onClick={() => selectColor(key)}
            />
          ))}
          <button
            type="button"
            disabled={noteInteractionDisabled}
            className={`category-note-icon-button${tool === 'eraser' ? ' is-active' : ''}`}
            aria-label="消しゴム"
            title="消しゴム"
            onClick={() => setTool('eraser')}
          >
            <EraserIcon />
          </button>
          <button
            type="button"
            className="category-note-icon-button"
            aria-label="戻す"
            title="戻す"
            disabled={noteInteractionDisabled || !canUndo}
            onClick={undo}
          >
            <UndoIcon />
          </button>
        </div>
        <div className="category-note-tool-group category-note-markers" aria-label="マーカー">
          <span>マーカー</span>
          {(Object.keys(MARKER_COLORS) as (keyof typeof MARKER_COLORS)[]).map(key => <button
            key={key} type="button" disabled={noteInteractionDisabled}
            aria-label={`${{ yellow: '黄色', green: '緑色', blue: '青色' }[key]}のマーカー`}
            aria-pressed={tool === 'marker' && markerColor === key}
            className={`category-note-marker${tool === 'marker' && markerColor === key ? ' is-active' : ''}`}
            onClick={() => { setMarkerColor(key); setTool('marker'); }}
          ><span style={{ background: MARKER_COLORS[key] }} /></button>)}
        </div>
      </div>

      <ConfirmDialog
        open={deletePageConfirmOpen}
        busy={isFlushing}
        title={'\u3053\u306e\u30da\u30fc\u30b8\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f'}
        message={'\u3053\u306e\u30da\u30fc\u30b8\u306b\u66f8\u3044\u305f\u30ce\u30fc\u30c8\u306f\u524a\u9664\u3055\u308c\u307e\u3059\u3002\n\u5143\u306b\u623b\u305b\u307e\u305b\u3093\u3002'}
        confirmLabel={'\u524a\u9664'}
        onCancel={() => setDeletePageConfirmOpen(false)}
        onConfirm={confirmDeletePage}
      />
    </section>
  );
});

function EraserIcon() {
  return (
    <svg className="category-note-svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.7 14.2 13.2 5.7a2.2 2.2 0 0 1 3.1 0l2 2a2.2 2.2 0 0 1 0 3.1l-7.1 7.1H6.4l-1.7-1.7a1.4 1.4 0 0 1 0-2Z" />
      <path d="M10.2 18h9" />
      <path d="m9.2 9.7 5.1 5.1" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg className="category-note-svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 8 4 13l5 5" />
      <path d="M4.8 13h9.7a5.2 5.2 0 0 1 0 10.4H11" />
    </svg>
  );
}

function normalizeCategory(category: string | null | undefined) {
  const value = category?.trim();
  return value || UNCATEGORIZED;
}

function getNoteKey(problemSetId: string, category: string) {
  return `quizMake:notes:${problemSetId}:${category}`;
}

function createBlankPage(): NotePage {
  return { id: createId('notePage'), dataUrl: '', updatedAt: new Date().toISOString() };
}

function createEmptyNote(problemSetId: string, category: string): CategoryNote {
  return {
    problemSetId,
    category,
    pages: [createBlankPage()],
    currentPageIndex: 0,
    updatedAt: new Date().toISOString(),
  };
}

function parseNote(raw: string | null, problemSetId: string, category: string): CategoryNote {
  try {
    if (!raw) return createEmptyNote(problemSetId, category);
    const parsed = JSON.parse(raw) as Partial<CategoryNote>;
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return migrateSinglePageNote(parsed, problemSetId, category);
    const pages = parsed.pages
      .filter((page): page is NotePage => Boolean(page && typeof page.id === 'string'))
      .map((page) => ({
        id: page.id,
        dataUrl: typeof page.dataUrl === 'string' ? page.dataUrl : '',
        updatedAt: typeof page.updatedAt === 'string' ? page.updatedAt : new Date().toISOString(),
      }));
    return {
      problemSetId,
      category,
      pages: pages.length > 0 ? pages : [createBlankPage()],
      currentPageIndex: typeof parsed.currentPageIndex === 'number' ? parsed.currentPageIndex : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return createEmptyNote(problemSetId, category);
  }
}

function migrateSinglePageNote(parsed: Partial<CategoryNote> & { dataUrl?: unknown }, problemSetId: string, category: string): CategoryNote {
  const page = createBlankPage();
  if (typeof parsed.dataUrl === 'string') page.dataUrl = parsed.dataUrl;
  return {
    problemSetId,
    category,
    pages: [page],
    currentPageIndex: 0,
    updatedAt: new Date().toISOString(),
  };
}

function getCanvasLogicalSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    width: canvas.offsetWidth || canvas.clientWidth || rect.width,
    height: canvas.offsetHeight || canvas.clientHeight || rect.height,
  };
}
function canDraw(event: PointerEvent<HTMLCanvasElement>) {
  return event.pointerType === 'pen' || event.pointerType === 'mouse';
}

function isPalmLikeTouch(event: PointerEvent<HTMLCanvasElement>) {
  if (event.pointerType !== 'touch') return false;
  const contactArea = event.width * event.height;
  return event.width >= 96 || event.height >= 96 || contactArea >= 8000;
}

function getCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent<HTMLCanvasElement>) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.offsetWidth > 0 ? canvas.offsetWidth / rect.width : 1;
  const scaleY = canvas.offsetHeight > 0 ? canvas.offsetHeight / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function getPointDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function preloadNoteImage(dataUrl: string | undefined) {
  if (!dataUrl || getCachedNoteImage(dataUrl)) return;
  const image = new Image();
  image.src = dataUrl;
  // Reserve the full cache budget while dimensions are unknown so concurrent
  // preloads cannot accumulate outside the byte limit.
  setCachedNoteImage(dataUrl, image, NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);
  void decodeNoteImage(image).then(
    () => updateCachedNoteImageWeight(dataUrl, image),
    () => {
      if (noteImageCache.peek(dataUrl) === image) noteImageCache.delete(dataUrl);
    },
  );
}

function getCachedNoteImage(dataUrl: string) {
  return noteImageCache.get(dataUrl);
}

function setCachedNoteImage(dataUrl: string, image: HTMLImageElement, byteSize: number) {
  noteImageCache.set(dataUrl, image, byteSize);
}

function updateCachedNoteImageWeight(dataUrl: string, image: HTMLImageElement) {
  if (noteImageCache.peek(dataUrl) !== image) return;
  setCachedNoteImage(dataUrl, image, estimateRgbaPixelBytes(image.naturalWidth, image.naturalHeight));
}
async function drawDataUrlToContext(
  context: CanvasRenderingContext2D,
  dataUrl: string,
  width: number,
  height: number,
  shouldDraw: () => boolean = () => true,
  transparent = false,
): Promise<void> {
  if (!shouldDraw()) return;
  context.clearRect(0, 0, width, height);
  if (!transparent) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
  if (!dataUrl) return;

  const cached = getCachedNoteImage(dataUrl);
  const image = cached ?? new Image();
  if (!cached) {
    image.src = dataUrl;
    setCachedNoteImage(dataUrl, image, NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);
  }
  try {
    await decodeNoteImage(image);
  } catch (error) {
    if (noteImageCache.get(dataUrl) === image) noteImageCache.delete(dataUrl);
    throw error;
  }
  updateCachedNoteImageWeight(dataUrl, image);
  if (shouldDraw()) context.drawImage(image, 0, 0, width, height);
}

async function decodeNoteImage(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === 'function') {
    await image.decode();
  } else if (!image.complete) {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Failed to decode note image.')), { once: true });
    });
  }
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('Failed to decode note image.');
}

























