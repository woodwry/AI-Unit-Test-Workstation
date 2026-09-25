import { AlertTriangle, X } from 'lucide-react';
import { useEffect } from 'react';
import { useDraggableDialog } from './use-draggable-dialog';

export function ModelInterfaceDeleteDialog({
  interfaceId,
  interfaceName,
  busy,
  onCancel,
  onDelete
}: {
  interfaceId: string;
  interfaceName: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { dialogRef, dialogStyle, dragHandleProps } =
    useDraggableDialog<HTMLDialogElement>(interfaceId);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [dialogRef]);

  return (
    <dialog
      ref={dialogRef}
      style={dialogStyle}
      className="model-interface-delete-dialog"
      aria-labelledby="model-interface-delete-title"
      aria-describedby="model-interface-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <header {...dragHandleProps}>
        <span className="model-interface-delete-icon" aria-hidden="true">
          <AlertTriangle size={17} />
        </span>
        <strong id="model-interface-delete-title">删除大模型接口</strong>
        <button
          type="button"
          aria-label="关闭删除确认"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={15} />
        </button>
      </header>
      <div className="model-interface-delete-body">
        <p>确定删除“<strong>{interfaceName}</strong>”吗？</p>
        <p id="model-interface-delete-description">删除后不会自动选择其他接口。</p>
      </div>
      <footer>
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
        <button
          type="button"
          className="model-interface-delete-confirm"
          disabled={busy}
          onClick={onDelete}
        >
          {busy ? '删除中…' : '删除'}
        </button>
      </footer>
    </dialog>
  );
}
