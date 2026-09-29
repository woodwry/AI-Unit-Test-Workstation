import { X } from 'lucide-react';
import type { ClassTaskSnapshot } from '../../../shared/class-task-contracts';
import { describeClassTaskDeleteConfirmation } from './class-task-card-view';

type DeleteClassTaskDialogProps = {
  task: Pick<ClassTaskSnapshot, 'sourceFilePath' | 'state' | 'preloadState'>;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteClassTaskDialog({
  task,
  onCancel,
  onConfirm
}: DeleteClassTaskDialogProps): JSX.Element {
  const copy = describeClassTaskDeleteConfirmation(task);
  return (
    <div className="class-task-terminate-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="class-task-terminate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-task-delete-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong id="class-task-delete-title">{copy.title}</strong>
          <button type="button" title="关闭" aria-label="关闭" onClick={onCancel}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <p>{copy.message}</p>
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button className="danger" type="button" onClick={onConfirm}>{copy.confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
