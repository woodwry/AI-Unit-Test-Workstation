import { useEffect, useRef, useState } from 'react';
import { Plus, Search, ArrowLeft, Trash2, LoaderCircle, X, Box, TriangleAlert, RefreshCw, Square } from 'lucide-react';
import type { GlobalKnowledgeModule, RagKnowledgeAppApi, RagKnowledgeEntryView, RagKnowledgeEntriesPage, RagKnowledgeMethodsPage, RagKnowledgeMethodView } from '../../../shared/rag-knowledge-contracts';
import { KnowledgeText } from './KnowledgeText';
import { useDraggableDialog } from '../use-draggable-dialog';

export type RagMethodOpen = (
  entry: RagKnowledgeEntryView,
  method: RagKnowledgeMethodView,
  indexGeneration: number,
  configurationId: string
) => Promise<void>;

type Props = { workspaceRoot: string; api: RagKnowledgeAppApi; onOpenMethod: RagMethodOpen; activeMethodId?: string; onOpenRagSettings(): void };
function userFacingKnowledgeError(message: string): string {
  const cleaned = message
    .replace(/^Error:\s*Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(?:Error|TypeError):\s*/i, '')
    .trim();

  if (/\b(?:500|502|503|504)\b/.test(cleaned)) {
    return '服务处理请求时出现异常，请稍后重试。';
  }
  if (/\b(?:401|403)\b/.test(cleaned)) {
    return '当前登录状态不可用，请重新登录后再试。';
  }
  if (/failed to fetch|fetch failed|econnrefused|network error|无法连接/i.test(cleaned)) {
    return '无法连接知识库服务，请确认后端服务正在运行。';
  }
  return cleaned || '知识库请求未完成，请稍后重试。';
}
export function GlobalKnowledgePanel({ workspaceRoot, api, onOpenMethod, activeMethodId, onOpenRagSettings }: Props): JSX.Element {
  const [entry, setEntry] = useState<RagKnowledgeEntryView | null>(null);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Array<RagKnowledgeEntryView | RagKnowledgeMethodView>>([]);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [generation, setGeneration] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const loading = useRef(false);
  const loadedKey = useRef('');
  const pageKey = JSON.stringify([entry?.entryId, query, revision]);
  const id = (row: typeof rows[number]) => 'methodId' in row ? row.methodId : row.entryId;
  useEffect(()=>{setBatch(false);setSelected([]);},[entry?.entryId]);
  useEffect(() => api.onRagKnowledgeChanged(() => setRevision(v => v + 1)), [api]);
  useEffect(() => { loadedKey.current=''; setBusy(true); setSelected([]); setRows([]); setCursor(null); setError(''); const current = ++epoch.current; loading.current = false;
    const timer = window.setTimeout(() => void load(null, current), query ? 250 : 0);
    return () => { clearTimeout(timer); epoch.current++; };
  }, [entry?.entryId, query, revision]);
  async function load(next: string | null, current = epoch.current): Promise<void> {
    if (loading.current) return;
    loading.current = true; setBusy(true);
    try {
      const page = await api.globalKnowledge<RagKnowledgeEntriesPage | RagKnowledgeMethodsPage>({ action: entry ? 'methods' : 'entries', entryId: entry?.entryId, query, cursor: next });
      if (current !== epoch.current) return;
      loadedKey.current=pageKey;
      setRows(old => next ? [...old, ...page.items] : page.items); setCursor(page.nextCursor); setGeneration(page.indexGeneration);
    } catch (failure) { if (current === epoch.current) setError(String(failure)); }
    finally { if (current === epoch.current) { loading.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (loadedKey.current !== pageKey || !cursor || busy || error || !sentinel.current) return;
    const observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) void load(cursor); }, { root: list.current });
    observer.observe(sentinel.current); return () => observer.disconnect();
  }, [cursor, busy, error, entry, query]);
  async function remove(): Promise<void> {
    if (!confirmIds) return;
    setBusy(true);
    try { await api.globalKnowledge({ action:'delete', ...(entry ? { entryId:entry.entryId, methodIds:confirmIds } : { entryIds:confirmIds }) }); setConfirmIds(null); setBatch(false); setSelected([]); setRevision(v=>v+1); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  function refreshCurrentView(): void {
    setBatch(false);
    setSelected([]);
    setRevision(value => value + 1);
  }
  const errorMessage = userFacingKnowledgeError(error);
  return <section className="rag-knowledge-panel global-knowledge-panel" aria-label="RAG 知识库">
    <header className="global-rag-toolbar global-rag-header"><strong>RAG 知识库</strong><div className="global-rag-header-actions"><button aria-label="刷新" disabled={busy} onClick={refreshCurrentView}><RefreshCw className={busy?'spin':undefined} size={15}/></button><button title="添加知识" aria-label="添加知识" onClick={()=>setAdding(true)}><Plus size={16}/></button></div></header>
    {entry && <div className="global-rag-heading"><button onClick={()=>{setEntry(null);setQuery('');}}><ArrowLeft size={14}/>返回类列表</button><KnowledgeText className="knowledge-class-name" text={entry.simpleName}/><KnowledgeText text={entry.classFqn}/><KnowledgeText className="knowledge-version" text={entry.versionPath}/></div>}
    <label className="rag-knowledge-search"><Search size={14}/><input aria-label={entry ? '搜索当前类的方法' : '搜索 RAG 知识库'} placeholder={entry ? '搜索方法名或签名' : '搜索类名、包路径或 Maven 坐标'} value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {!error && (rows.length > 0 || batch) && <div className="global-rag-selection">{batch?<><label><input type="checkbox" aria-label="全选当前已加载项" checked={rows.length>0&&selected.length===rows.length} ref={node=>{if(node)node.indeterminate=selected.length>0&&selected.length<rows.length;}} onChange={e=>setSelected(e.target.checked?rows.map(id):[])}/>全选</label><button className="global-rag-batch-cancel" onClick={()=>{setBatch(false);setSelected([]);}}>取消</button></>:<><span>{cursor?'已加载 ':''}{rows.length} 个{entry?'方法':'类'}</span><button className="global-rag-batch-entry" onClick={()=>setBatch(true)}><Trash2 size={13}/>批量删除</button></>}</div>}
    {error ? <section role="alert" aria-live="assertive" className="rag-knowledge-error-state">
      <div className="rag-knowledge-error-heading">
        <span className="rag-knowledge-error-icon" aria-hidden="true"><TriangleAlert size={16}/></span>
        <strong>知识库暂时不可用</strong>
      </div>
      <p className="rag-knowledge-error-message">{errorMessage}</p>
      <div className="rag-knowledge-error-actions">
        <button type="button" className="rag-knowledge-error-retry" onClick={refreshCurrentView}><RefreshCw size={12}/>重试</button>
        <button type="button" className="rag-knowledge-error-settings" onClick={onOpenRagSettings}>向量模型设置</button>
      </div>
    </section> : <>
      <div ref={list} className="rag-knowledge-list" aria-label={entry ? 'RAG 知识库方法列表' : 'RAG 知识库类列表'}>
        {rows.map(row=><article className={`rag-knowledge-row ${entry ? 'rag-method-row' : ''}${id(row)===activeMethodId || selected.includes(id(row)) ? ' selected':''}`} key={id(row)} onClickCapture={event=>{
          if(!batch || (event.target as Element).closest('input, .knowledge-expanded-text'))return;
          event.stopPropagation();
          setSelected(old=>old.includes(id(row))?old.filter(value=>value!==id(row)):[...old,id(row)]);
        }}>
          {batch&&<input type="checkbox" aria-label={`选择 ${'methodName' in row ? row.canonicalSignature : row.classFqn}`} checked={selected.includes(id(row))} onChange={e=>setSelected(old=>e.target.checked ? [...old,id(row)] : old.filter(value=>value!==id(row)))}/>}
          <button className="rag-knowledge-open" onClick={()=>{if(batch){setSelected(old=>old.includes(id(row))?old.filter(value=>value!==id(row)):[...old,id(row)]);return;}if ('methodId' in row && entry) void onOpenMethod(entry,row,generation,'global').catch(f=>setError(String(f))); else {setEntry(row as RagKnowledgeEntryView);setQuery('');}}}>
            <div className="rag-knowledge-copy"><strong><span className="global-rag-kind" aria-hidden="true">{'methodName' in row ? 'M' : 'C'}</span>{'methodName' in row ? row.methodName : row.simpleName}</strong><KnowledgeText text={'methodName' in row ? row.declarationSignature || row.canonicalSignature : row.classFqn}/>{'versionPath' in row && <KnowledgeText className="knowledge-version" text={row.versionPath}/>}</div>
          </button>{!batch&&<button className="rag-knowledge-delete-button" aria-label={`删除 ${'methodName' in row ? row.canonicalSignature : row.classFqn}`} onClick={()=>setConfirmIds([id(row)])}><Trash2 size={14}/></button>}
        </article>)}
        {busy && <div role="status" className="rag-scroll-loader"><LoaderCircle className="spin" size={16}/></div>}
        {!busy && !rows.length && <div className="rag-knowledge-empty">{query ? '没有匹配项' : <><span className="global-rag-empty-icon"><Box size={27}/></span><p>{entry ? '当前类暂无方法，可重新导入类文件' : '暂无内容，点击下方按钮开始导入'}</p><button className="global-rag-primary" onClick={()=>setAdding(true)}>添加</button></>}</div>}
        <div ref={sentinel} className="rag-scroll-sentinel"/>
      </div>
      {batch&&<div className="global-rag-batch-footer"><span>已选 {selected.length} 项</span><button disabled={busy||!selected.length} onClick={()=>setConfirmIds([...selected])}>删除</button></div>}
    </>}
    {adding && <GlobalImportDialog api={api} onClose={()=>{setAdding(false);setRevision(v=>v+1);}}/>}
    {confirmIds && <div className="rag-modal-backdrop"><section className="global-rag-delete-dialog" role="dialog" aria-modal="true" aria-label={entry ? '确认删除方法' : '确认删除类'}><header><span className="global-rag-delete-symbol"><Trash2 size={15}/></span><strong>删除{entry?'方法':'类'}</strong><small>已选择 {confirmIds.length} 项</small><button disabled={busy} aria-label="关闭确认" onClick={()=>setConfirmIds(null)}><X size={15}/></button></header><div className="global-rag-delete-body"><div className="global-rag-delete-targets">{rows.filter(row=>confirmIds.includes(id(row))).map(row=><div key={id(row)} onClickCapture={event=>{
        if(!batch || (event.target as Element).closest('input, .knowledge-expanded-text'))return;
        event.stopPropagation();
        setSelected(old=>old.includes(id(row))?old.filter(value=>value!==id(row)):[...old,id(row)]);
      }}><span className="global-rag-kind">{entry?'M':'C'}</span><span>{'methodName' in row ? row.declarationSignature||row.canonicalSignature : row.simpleName}</span></div>)}</div><p>{entry?'所选方法及对应向量将从知识库中删除。':'所选类、类内所有方法及对应向量将从知识库中删除。'}</p><div className="global-rag-delete-warning"><TriangleAlert size={14}/>影响所有项目，删除后无法撤销。</div></div><footer><button autoFocus disabled={busy} onClick={()=>setConfirmIds(null)}>取消</button><button className="global-rag-delete-confirm" disabled={busy} onClick={()=>void remove()}>删除</button></footer></section></div>}
  </section>;
}

function GlobalImportDialog({api,onClose}:{api:RagKnowledgeAppApi;onClose():void}):JSX.Element {
  const [modules,setModules]=useState<GlobalKnowledgeModule[]>([]);
  const [module,setModule]=useState<GlobalKnowledgeModule|null>(null);
  const [busy,setBusy]=useState(false);
  const [stopping,setStopping]=useState(false);
  const [deletingEntryIds,setDeletingEntryIds]=useState<Set<string>>(new Set());
  const [status,setStatus]=useState('');
  const [error,setErrorMessage]=useState('');
  const noticeRef=useRef<HTMLDivElement>(null);
  function setError(message:string):void {
    const cleaned=message.replace(/^Error:\s*Error invoking remote method '[^']+':\s*/,'').replace(/^(?:Error|TypeError):\s*/,'');
    setErrorMessage(cleaned);
  }
  useEffect(()=>{
    if(!error)return;
    const timer=window.setTimeout(()=>setErrorMessage(''),3000);
    const dismiss=(event:PointerEvent)=>{if(!noticeRef.current?.contains(event.target as Node))setErrorMessage('');};
    document.addEventListener('pointerdown',dismiss,true);
    return ()=>{window.clearTimeout(timer);document.removeEventListener('pointerdown',dismiss,true);};
  },[error]);
  const [importedClasses,setImportedClasses]=useState<Record<string,Array<{entryId:string;classFqn:string}>>>({});
  const classes=module ? importedClasses[module.moduleId] ?? [] : [];
  const locked=useRef(false);
  const cancelRequested=useRef(false);

  const { dialogRef, dialogStyle, dragHandleProps } = useDraggableDialog<HTMLElement>(true);
  async function add(paths:string[],archiveEntries?:string[]):Promise<void> {
    if(locked.current || !paths.length)return;
    cancelRequested.current=false;locked.current=true;setBusy(true);setStopping(false);setError('');setStatus(module?'正在解析全部方法并构建向量…':'正在添加 POM…');
    try {
      const response=await api.globalKnowledge<{items:Array<{error?:string;module?:GlobalKnowledgeModule;entryId?:string;classFqn?:string;methodCount?:number}>}>({action:module?'import':'add-poms',moduleId:module?.moduleId,paths,...(archiveEntries?{archiveEntries}:{})});
      const failures=response.items.filter(item=>item.error);

      if(failures.length)setError(failures.map(item=>item.error).join('\n'));
      if(module) {
        const imported=response.items.filter((item):item is typeof item & {entryId:string;classFqn:string}=>!item.error&&Boolean(item.entryId)&&Boolean(item.classFqn))
          .map(item=>({entryId:item.entryId,classFqn:item.classFqn}));
        setImportedClasses(old=>({...old,[module.moduleId]:Array.from(new Map([...(old[module.moduleId]??[]),...imported].map(item=>[item.entryId,item])).values())}));
      } else {
        const added=response.items.filter(item=>!item.error&&item.module).map(item=>item.module!);
        setModules(old=>Array.from(new Map([...old,...added].map(item=>[item.moduleId,item])).values()));
      }
    }catch(failure){if(!cancelRequested.current)setError(String(failure));}finally{locked.current=false;setBusy(false);setStopping(false);if(cancelRequested.current)setStatus('');}
  }
  async function stopImport():Promise<void> {
    if(!busy||stopping)return;
    cancelRequested.current=true;setStopping(true);setStatus('正在停止本次构建…');
    try{await api.cancelGlobalKnowledgeImport();}
    catch(failure){cancelRequested.current=false;setError(String(failure));}
  }
  async function removeImportedClass(item:{entryId:string;classFqn:string}):Promise<void> {
    if(deletingEntryIds.has(item.entryId))return;
    setDeletingEntryIds(old=>new Set(old).add(item.entryId));setError('');
    try{
      await api.globalKnowledge({action:'delete',entryIds:[item.entryId]});
      if(module)setImportedClasses(old=>({...old,[module.moduleId]:(old[module.moduleId]??[]).filter(candidate=>candidate.entryId!==item.entryId)}));
    }catch(failure){setError(String(failure));}
    finally{setDeletingEntryIds(old=>{const next=new Set(old);next.delete(item.entryId);return next;});}
  }
  function paths(data:DataTransfer):string[]{
    const files=Array.from(data.files).map(file=>window.workstation.getPathForFile(file)).filter(Boolean);
    return files.length ? files : data.getData('text/plain').split(/\r?\n/).map(line=>line.trim().replace(/^"|"$/g,'')).filter(Boolean);
  }
  return <div className="rag-modal-backdrop"><section ref={dialogRef} style={dialogStyle} className="global-rag-import" role="dialog" aria-modal="true" aria-label="添加全局知识" tabIndex={0}
    onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';}} onDrop={e=>{e.preventDefault();void add(paths(e.dataTransfer));}}
    onPaste={e=>{e.preventDefault();const values=paths(e.clipboardData); if(values.length) void add(values); else void api.globalKnowledge<string[]>({action:'clipboard-paths'}).then(add).catch(f=>setError(String(f)));}}>
    <header className="global-rag-toolbar global-rag-drag-handle" {...dragHandleProps}>{module && <button disabled={busy} onClick={()=>{setModule(null);setStatus('');setError('');}}><ArrowLeft size={16}/>返回</button>}<strong>{module?module.artifactId:'添加知识'}</strong><button disabled={busy} aria-label="关闭" onClick={onClose}><X size={18}/></button></header>
    <div className="global-rag-import-description-row"><p className="global-rag-import-description">{module ? module.coordinate : '先添加 POM 文件，再导入对应的类文件。'}</p>{error&&<div ref={noticeRef} role="alert" className="global-rag-import-notice">{error}</div>}</div>

    <div className="global-rag-drop" tabIndex={0}><button className="global-rag-file-picker" type="button" disabled={busy} aria-label={module ? '选择 Java 或 Class 文件' : '选择 POM 文件'} onClick={()=>{void api.globalKnowledge<string[]>({action:'pick-files',fileKind:module?'class':'pom'}).then(paths=>add(paths)).catch(f=>setError(String(f)));}}><Plus size={20}/></button><p>{module ? '拖拽或粘贴 Java / Class 文件' : '拖拽或粘贴 POM 文件'}</p><small>支持批量添加</small></div>
    {busy && <div role="status" className="global-rag-import-progress"><span><LoaderCircle size={14} className="spin"/> {status}</span>{module&&<button type="button" disabled={stopping} aria-label={stopping?'正在停止':'停止'} onClick={()=>void stopImport()}>{stopping?<LoaderCircle size={14} className="spin"/>:<Square size={13} fill="currentColor"/>}</button>}</div>}

    <div className="global-rag-import-list">{module ? classes.map(item=><div className="global-rag-import-class" key={item.entryId}><span>{item.classFqn}</span><button type="button" disabled={busy||deletingEntryIds.has(item.entryId)} aria-label={`删除类 ${item.classFqn}`} onClick={()=>void removeImportedClass(item)}>{deletingEntryIds.has(item.entryId)?<LoaderCircle size={14} className="spin"/>:<Trash2 size={15}/>}</button></div>) : modules.map(item=><div className="global-rag-import-module" key={item.moduleId}><button className="global-rag-import-module-open" disabled={busy} onClick={()=>{setModule(item);setStatus('');setError('');}}><strong>{item.artifactId}</strong><code>{item.coordinate}</code></button><button className="global-rag-import-module-delete" type="button" disabled={busy} aria-label={`删除 POM ${item.coordinate}`} onClick={()=>setModules(old=>old.filter(candidate=>candidate.moduleId!==item.moduleId))}><Trash2 size={15}/></button></div>)}</div>
    </section></div>;
}
