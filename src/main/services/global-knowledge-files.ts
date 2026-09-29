import { promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import * as yauzl from 'yauzl';
import type { GlobalFileBrowserPage, GlobalKnowledgeRequest } from '../../shared/rag-knowledge-contracts';

const MAX_FILE = 12_000_000;
const MAX_BATCH = 128_000_000;
export function matchesKnowledgeFile(name:string, kind:'pom'|'class'):boolean {
  return kind==='pom' ? basename(name).toLowerCase()==='pom.xml' : ['.class','.java'].includes(extname(name).toLowerCase());
}
// Stream selected archive members into memory; never extract paths onto disk.
export async function readKnowledgeArchive(path:string, selected?:string[]):Promise<Array<{name:string;content?:Buffer}>> {
  if(!isAbsolute(path) || extname(path).toLowerCase()!=='.jar')throw new Error('请选择 JAR 文件');
  const stat=await fs.stat(path);
  if(!stat.isFile() || stat.size>1_000_000_000)throw new Error('JAR 文件超过 1 GB');
  const wanted=selected ? new Set(selected) : null;
  if(wanted && (!wanted.size || wanted.size>500))throw new Error('每批请选择 1 至 500 个文件');
  return new Promise((resolve,reject)=>{
    yauzl.open(path,{lazyEntries:true,autoClose:true},(error,zip)=>{
      if(error || !zip){reject(error ?? new Error('无法打开 JAR'));return;}
      const result:Array<{name:string;content?:Buffer}>=[];
      let count=0,total=0,done=false;
      const fail=(error:unknown)=>{if(done)return;done=true;zip.close();reject(error);};
      zip.on('error',fail);
      zip.on('end',()=>{if(done)return;done=true;if(wanted && result.length!==wanted.size)reject(new Error('JAR 中的文件已变化，请重新选择'));else resolve(result);});
      zip.on('entry',(entry:yauzl.Entry)=>{
        if(++count>100000){fail(new Error('JAR 条目过多'));return;}
        if(entry.fileName.endsWith('/') || (wanted && !wanted.has(entry.fileName))){zip.readEntry();return;}
        if(!wanted){result.push({name:entry.fileName});zip.readEntry();return;}
        if(entry.uncompressedSize>MAX_FILE || total+entry.uncompressedSize>MAX_BATCH){fail(new Error('所选文件超过大小限制'));return;}
        zip.openReadStream(entry,(error,stream)=>{
          if(error || !stream){fail(error ?? new Error('读取 JAR 失败'));return;}
          const chunks:Buffer[]=[];let size=0;
          stream.on('error',fail);
          stream.on('data',(chunk:Buffer)=>{size+=chunk.length;total+=chunk.length;if(size>MAX_FILE || total>MAX_BATCH){stream.destroy();fail(new Error('所选文件超过大小限制'));return;}chunks.push(chunk);});
          stream.on('end',()=>{if(done)return;result.push({name:entry.fileName,content:Buffer.concat(chunks)});zip.readEntry();});
        });
      });
      zip.readEntry();
    });
  });
}

export async function browseKnowledgeFiles(request:GlobalKnowledgeRequest, statePath:string):Promise<GlobalFileBrowserPage> {
  const kind=request.fileKind;
  if(kind!=='pom' && kind!=='class')throw new Error('文件类型不支持');
  let saved:Partial<Record<'pom'|'class',{path:string;prefix:string}>>={};
  try{saved=JSON.parse(await fs.readFile(statePath,'utf8'));}catch{/* First use starts at home. */}
  const remembered=saved[kind];
  let path=request.paths?.[0] ?? remembered?.path ?? homedir();
  let prefix=request.query ?? (request.paths ? '' : remembered?.prefix ?? '');
  if(typeof path!=='string' || !isAbsolute(path) || typeof prefix!=='string')throw new Error('无效的浏览路径');
  if(!request.paths){try{await fs.stat(path);}catch{path=homedir();prefix='';}}
  const stat=await fs.stat(path);
  const items:GlobalFileBrowserPage['items']=[];
  let archive=false;
  if(stat.isDirectory()){
    prefix='';
    const entries=await fs.readdir(path,{withFileTypes:true});
    for(const entry of entries){
      if(entry.isDirectory())items.push({name:entry.name,path:join(path,entry.name),kind:'directory'});
      else if(entry.isFile() && extname(entry.name).toLowerCase()==='.jar')items.push({name:entry.name,path:join(path,entry.name),kind:'archive'});
      else if(entry.isFile() && matchesKnowledgeFile(entry.name,kind))items.push({name:entry.name,path:join(path,entry.name),kind:'file'});
    }
  }else{
    archive=true;
    const entries=await readKnowledgeArchive(path);
    const folders=new Set<string>();
    for(const entry of entries){
      if(!matchesKnowledgeFile(entry.name,kind) || !entry.name.startsWith(prefix))continue;
      const rest=entry.name.slice(prefix.length),slash=rest.indexOf('/');
      if(slash>=0)folders.add(rest.slice(0,slash));
      else items.push({name:rest,path:entry.name,kind:'file'});
    }
    for(const folder of folders)items.push({name:folder,path:prefix+folder+'/',kind:'directory'});
  }
  items.sort((a,b)=>(a.kind==='file'?1:0)-(b.kind==='file'?1:0)||a.name.localeCompare(b.name));
  saved[kind]={path,prefix};
  await fs.mkdir(dirname(statePath),{recursive:true});
  await fs.writeFile(statePath,JSON.stringify(saved),'utf8');
  return {path,prefix,archive,parent:archive ? (prefix ? path : dirname(path)) : dirname(path),parentPrefix:archive && prefix ? prefix.replace(/[^/]+\/$/,'') : '',items};
}