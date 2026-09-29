import { X } from 'lucide-react';

type TerminateAllDialogProps = {
  activeCount: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function TerminateAllDialog({
  activeCount,
  busy = false,
  onCancel,
  onConfirm
}: TerminateAllDialogProps): JSX.Element {
  return (
    <div className="class-task-terminate-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="class-task-terminate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-task-terminate-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong id="class-task-terminate-title">终止全部任务？</strong>
          <button type="button" title="关闭" aria-label="关闭" disabled={busy} onClick={onCancel}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <p>将终止 {activeCount} 个正在执行或暂停的任务。已生成且验证通过的结果会保留，尚未完成的步骤不会继续。</p>
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="danger" type="button" disabled={busy} aria-busy={busy} onClick={onConfirm}>
            <span>终止</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
