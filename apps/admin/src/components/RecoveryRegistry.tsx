import {useEffect,useState} from 'react';
import type {AdminClient,CourseWorkspace} from '../domain/contracts';
import {Card,Notice} from './ui';

export function RecoveryRegistry({data,client}:{data:CourseWorkspace;client:AdminClient}){
  const [releaseId,setReleaseId]=useState(data.releases[0]?.id??''),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [runtime,setRuntime]=useState<Awaited<ReturnType<NonNullable<AdminClient['adaptationRuntime']>>>>(),[registry,setRegistry]=useState<Awaited<ReturnType<NonNullable<AdminClient['adaptationRegistry']>>>>();
  const allowed=client.mode==='connected'&&['owner','admin'].includes(data.role??'')&&Boolean(client.adaptationRuntime&&client.adaptationRegistry&&client.approveAdaptationRegistry);
  async function refresh(){if(!allowed||!releaseId)return;setBusy(true);setError('');try{const [installed,state]=await Promise.all([client.adaptationRuntime!(),client.adaptationRegistry!(releaseId)]);setRuntime(installed);setRegistry(state);}catch{setError('Recovery settings could not be loaded. Your draft is preserved.');}finally{setBusy(false);}}
  useEffect(()=>{let active=true;setRegistry(undefined);setBusy(true);if(!allowed||!releaseId){setBusy(false);return;}Promise.all([client.adaptationRuntime!(),client.adaptationRegistry!(releaseId)]).then(([r,s])=>{if(active){setRuntime(r);setRegistry(s);setError('');}}).catch(()=>{if(active)setError('Recovery settings could not be loaded.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[client,releaseId,allowed]);
  async function approve(){if(!registry||!allowed)return;let parsed:unknown;try{if(draft.length>1500000)throw new Error();parsed=JSON.parse(draft);}catch{setError('Provide a bounded valid JSON registry configuration.');return;}setBusy(true);setError('');setNotice('');try{const receipt=await client.approveAdaptationRegistry!(releaseId,registry.registryRevision,parsed);setRegistry({...registry,registryRevision:receipt.registryRevision,configured:true});setNotice('Registry approved for this immutable release. Generation still rechecks learner scope, evidence, cost and course limits.');}catch{setError('Approval could not be confirmed. Refresh the registry revision before retrying; your draft is preserved.');}finally{setBusy(false);}}
  return <Card title="Verified recovery checks" eyebrow="Release-scoped author approval">
    <p>Install trusted creators on the server, then approve their exact implementations, canonical families, reviewed banks and assignment costs. This does not grant mastery or expand a course allowance.</p>
    {!allowed?<Notice tone="gold">A connected owner or administrator can configure qualified recovery.</Notice>:<div className="page-stack">
      <label>Recovery release<select aria-label="Recovery release" value={releaseId} disabled={busy} onChange={e=>{setReleaseId(e.target.value);setNotice('');}}>{data.releases.map(r=><option key={r.id} value={r.id}>{r.version} · {r.state}</option>)}</select></label>
      {runtime&&<div><h3>Installed trusted creators</h3>{runtime.adapters.length?runtime.adapters.map(a=><p key={a.id}><strong>{a.id}</strong> · {a.kind}<br/><code style={{overflowWrap:'anywhere'}}>{a.implementationDigest}</code></p>):<Notice tone="gold">No recovery creators are installed. The server operator must enable qualified implementations first.</Notice>}</div>}
      {registry&&<p>Registry revision {registry.registryRevision} · {registry.configured?'approved':'not approved'}</p>}
      <label>Recovery registry configuration<textarea aria-label="Recovery registry configuration" rows={10} value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)} spellCheck={false}/></label>
      <small>Server-only answer banks belong here. Learner views never receive this configuration. Changing costs or implementations requires a new checked approval.</small>
      {error&&<Notice tone="red">{error}</Notice>}{notice&&<Notice tone="green">{notice}</Notice>}
      <div className="button-row"><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh recovery registry</button><button type="button" disabled={busy||!registry||!runtime?.adapters.length||!draft.trim()} onClick={()=>void approve()}>Approve recovery registry</button></div>
    </div>}
  </Card>;
}
