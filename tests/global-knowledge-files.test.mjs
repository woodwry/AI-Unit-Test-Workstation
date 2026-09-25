import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browseKnowledgeFiles,readKnowledgeArchive} from '../src/main/services/global-knowledge-files.ts';
import {executeGlobalKnowledge} from '../src/main/services/global-knowledge.service.ts';
function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,value] of Object.entries(files)){
    const n=Buffer.from(name),data=Buffer.from(value),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(l,n,data);central.push(c,n);offset+=l.length+n.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
test('JAR filters, selected import and independent remembered locations',async()=>{
  const root=await mkdtemp(join(tmpdir(),'knowledge-files-'));
  try{
    const jar=join(root,'sample.jar'),state=join(root,'positions.json');
    await writeFile(jar,zip({'pkg/A.class':'class-a','pkg/B.class':'class-b','META-INF/maven/demo/pom.xml':'<project/>','random.xml':'ignored','test.pom':'ignored'}));
    await writeFile(join(root,'pom.xml'),'<project/>');await writeFile(join(root,'random.xml'),'ignored');
    const local=await browseKnowledgeFiles({action:'browse-files',fileKind:'pom',paths:[root]},state);
    assert.deepEqual(local.items.map(x=>x.name).sort(),['pom.xml','sample.jar']);
    const pom=await browseKnowledgeFiles({action:'browse-files',fileKind:'pom',paths:[jar],query:'META-INF/maven/demo/'},state);
    assert.deepEqual(pom.items.map(x=>x.name),['pom.xml']);
    const classes=await browseKnowledgeFiles({action:'browse-files',fileKind:'class',paths:[jar],query:'pkg/'},state);
    assert.deepEqual(classes.items.map(x=>x.name),['A.class','B.class']);
    assert.equal((await browseKnowledgeFiles({action:'browse-files',fileKind:'pom'},state)).prefix,'META-INF/maven/demo/');
    assert.equal((await browseKnowledgeFiles({action:'browse-files',fileKind:'class'},state)).prefix,'pkg/');
    const content=await readKnowledgeArchive(jar,['pkg/A.class']);assert.equal(content[0].content.toString(),'class-a');
    await assert.rejects(readKnowledgeArchive(jar,['missing.class']),/已变化/);
    let sent;
    const embeddingConfig={provider:'custom_openai',model:'embed',baseUrl:'https://embedding.example/v1',credentials:{apiKey:'secret'}};
    const options={
      aiClient:{globalKnowledge:async body=>{sent=body;return {items:[]};}},
      embeddings:{
        getView:async()=>({activeInterfaceId:'embedding',interfaces:[{id:'embedding',baseUrl:embeddingConfig.baseUrl,embeddingModel:embeddingConfig.model}]}),
        resolveRuntime:async()=>({embeddingConfig})
      }
    };
    await executeGlobalKnowledge({action:'add-poms',paths:[jar],archiveEntries:['META-INF/maven/demo/pom.xml']},options);
    assert.deepEqual(sent.files,[{name:'pom.xml',content:'<project/>'}]);
    await executeGlobalKnowledge({action:'import',paths:[jar],archiveEntries:['pkg/A.class','pkg/B.class'],moduleId:'m'},options);
    assert.equal(sent.files.length,2);assert.equal(Buffer.from(sent.files[0].content,'base64').toString(),'class-a');
  }finally{await rm(root,{recursive:true,force:true});}
});
