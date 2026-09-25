import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Folder, FileArchive, FileCode, X } from 'lucide-react';
import type { GlobalFileBrowserPage, RagKnowledgeAppApi } from '../../../shared/rag-knowledge-contracts';

type Props={api:RagKnowledgeAppApi;kind:'pom'|'class';onClose():void;onSelect(paths:string[],archiveEntries?:string[]):Promise<void>};
export function KnowledgeFileBrowser({api,kind,onClose,onSelect}:Props):JSX.Element {
  const [page,setPage]=useState<GlobalFileBrowserPage|null>(null);
  const [address,setAddress]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [filter,setFilter]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function navigate(path?:string,prefix=''):Promise<void>{
    setBusy(true);setError('');
    try{
      const next=await api.globalKnowledge<GlobalFileBrowserPage>({action:'browse-files',fileKind:kind,...(path?{paths:[path],query:prefix}:{})});
      setPage(next);setAddress(next.path);setSelected([]);setFilter('');
    }catch(failure){setError(String(failure).replace(/^Error:\s*Error invoking remote method '[^']+':\s*/,'').replace(/^Error:\s*/,''));}
    finally{setBusy(false);}
  }
  useEffect(()=>{void navigate();},[]);
  async function confirm():Promise<void>{
    if(!page || !selected.length)return;
    await onSelect(page.archive?[page.path]:selected,page.archive?selected:undefined);
  }
  return createPortal(<div className="knowledge-file-browser-backdrop" onPaste={event=>event.stopPropagation()} onDrop={event=>event.stopPropagation()}><section className="knowledge-file-browser" role="dialog" aria-modal="true" aria-label={kind==='pom'?'选择 pom.xml 文件':'选择类文件'}>
    <header><strong>{kind==='pom'?'选择 pom.xml 文件':'选择 Java / Class 文件'}</strong><button aria-label="关闭文件浏览器" onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={event=>{event.preventDefault();void navigate(address);}}><button type="button" aria-label="上一级" disabled={busy||!page} onClick={()=>page&&void navigate(page.parent,page.parentPrefix)}><ArrowLeft size={16}/></button><input aria-label="文件夹或 JAR 路径" value={address} onChange={event=>setAddress(event.target.value)}/><button disabled={busy}>前往</button></form>
    {page?.archive&&<div className="knowledge-archive-path">JAR 内路径：/{page.prefix}<button disabled={busy} onClick={()=>void navigate(page.path,'')}>根目录</button></div>}
    <input className="knowledge-file-search" aria-label="筛选文件" placeholder="筛选当前目录" value={filter} onChange={event=>setFilter(event.target.value)}/>
    {error&&<div role="alert">{error}</div>}
    <div className="knowledge-file-rows" aria-label="文件浏览列表">
      {busy?<div role="status">正在读取…</div>:page?.items.filter(item=>item.name.toLowerCase().includes(filter.toLowerCase())).map(item=><div className="knowledge-file-row" key={item.path}>
        {item.kind==='file'?<label><input type="checkbox" checked={selected.includes(item.path)} onChange={event=>setSelected(old=>event.target.checked?[...old,item.path]:old.filter(path=>path!==item.path))}/><FileCode size={16}/><span>{item.name}</span></label>:<button onClick={()=>void navigate(page.archive?page.path:item.path,page.archive?item.path:'')}>{item.kind==='archive'?<FileArchive size={17}/>:<Folder size={17}/>}<span>{item.name}</span><span>›</span></button>}
      </div>)}
      {!busy&&page&&!page.items.length&&<p>此目录没有可选文件</p>}
    </div>
    <footer><span>已选 {selected.length} 项</span><button onClick={onClose}>取消</button><button className="global-rag-primary" disabled={busy||!selected.length} onClick={()=>void confirm()}>添加所选</button></footer>
  </section></div>,document.body);
}