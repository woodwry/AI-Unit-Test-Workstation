import { LoaderCircle, X } from 'lucide-react';
import { useEffect } from 'react';

export function RagCatalogLoadingDialog({ onCancel }: { onCancel: () => void }): JSX.Element {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onCancel]);

  return <div className="rag-modal-backdrop" role="presentation">
    <section className="rag-dependency-import-dialog" role="dialog" aria-modal="true" aria-label="导入依赖类">
      <header>
        <strong>导入依赖类</strong>
        <button type="button" aria-label="关闭" onClick={onCancel}><X size={15} /></button>
      </header>
      <div className="rag-catalog-preparing" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={22} aria-hidden="true" />
        <div>
          <strong>正在准备项目依赖目录…</strong>
          <p>正在核对项目依赖并准备可搜索的类目录，完成后自动显示。</p>
          <p>首次解析或项目依赖变化时可能稍慢，可随时取消。</p>
        </div>
      </div>
      <footer className="rag-catalog-preparing-actions">
        <button type="button" autoFocus onClick={onCancel}>取消</button>
      </footer>
    </section>
  </div>;
}
