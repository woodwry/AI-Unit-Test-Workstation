import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler
} from 'react';

type DialogOffset = {
  x: number;
  y: number;
};

type DragSession = {
  bounds: DialogOffsetBounds;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startOffset: DialogOffset;
};

type DialogOffsetBounds = {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
};

type DialogDragHandleProps = {
  'data-dialog-dragging': 'true' | undefined;
  onLostPointerCapture: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
};

const INTERACTIVE_TARGET_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[data-no-dialog-drag]',
  '[role="button"]'
].join(',');

const ZERO_OFFSET: DialogOffset = { x: 0, y: 0 };
const VIEWPORT_INSET = 8;

export function useDraggableDialog<T extends HTMLElement>(resetKey: unknown): {
  dialogRef: React.MutableRefObject<T | null>;
  dialogStyle: CSSProperties;
  dragHandleProps: DialogDragHandleProps;
} {
  const dialogRef = useRef<T>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const [offset, setOffset] = useState<DialogOffset>(ZERO_OFFSET);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    dragSessionRef.current = null;
    setIsDragging(false);
    setOffset(ZERO_OFFSET);
  }, [resetKey]);

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0 || !event.isPrimary || isInteractiveTarget(event.target)) return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();

    dragSessionRef.current = {
      bounds: {
        maxX: offset.x + window.innerWidth - VIEWPORT_INSET - rect.right,
        maxY: offset.y + window.innerHeight - VIEWPORT_INSET - rect.bottom,
        minX: offset.x + VIEWPORT_INSET - rect.left,
        minY: offset.y + VIEWPORT_INSET - rect.top
      },
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset: offset
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    event.preventDefault();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>): void {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    setOffset({
      x: clamp(
        session.startOffset.x + event.clientX - session.startClientX,
        session.bounds.minX,
        session.bounds.maxX
      ),
      y: clamp(
        session.startOffset.y + event.clientY - session.startClientY,
        session.bounds.minY,
        session.bounds.maxY
      )
    });
  }

  function finishDragging(event: ReactPointerEvent<HTMLElement>): void {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    dragSessionRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return {
    dialogRef,
    dialogStyle: { translate: `${offset.x}px ${offset.y}px` },
    dragHandleProps: {
      'data-dialog-dragging': isDragging ? 'true' : undefined,
      onLostPointerCapture: finishDragging,
      onPointerCancel: finishDragging,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: finishDragging
    }
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_TARGET_SELECTOR) !== null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2;
  return Math.min(Math.max(value, minimum), maximum);
}
