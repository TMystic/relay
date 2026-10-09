// No client receives the server key. Every operation requires a room capability;
// provisioning additionally requires the owner's setup secret.
const MAX=18*1024*1024;
const hex=(value,n)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(value);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
async function body(req) {
 const reader=req.body?.getReader();if(!reader)throw new Error('Missing body');
 const chunks=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX)throw new Error('Too large');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
export function handler({url,key,fetchImpl=fetch}) {
 if(!url||!key)throw new Error('Server recovery credentials are missing.');
 return async req=>{
  if(req.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const bearer=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!bearer)return Response.json({error:'Unauthorized'},{status:401});
  try {
   const data=await body(req);
   if(!hex(data.room,32)||!['provision','list','get','put'].includes(data.op))
    return Response.json({error:'Invalid request'},{status:400});
   if(['get','put'].includes(data.op)&&!hex(data.device,32))return Response.json({error:'Invalid device'},{status:400});
   if(data.op==='provision'&&!hex(data.setup,64))return Response.json({error:'Unauthorized'},{status:401});
   if(data.op==='put'&&(!hex(data.version,64)||(data.previous!==null&&!hex(data.previous,64))||
      typeof data.cipher!=='string'||data.cipher.length>16*1024*1024||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.cipher)))
    return Response.json({error:'Invalid copy'},{status:400});
   if(data.op==='put') {
    const binary=Uint8Array.from(atob(data.cipher),x=>x.charCodeAt(0));
    const version=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',binary)),x=>x.toString(16).padStart(2,'0')).join('');
    if(version!==data.version||binary.length<32||new TextDecoder().decode(binary.subarray(0,4))!=='RLC1')
     return Response.json({error:'Invalid copy'},{status:400});
   }
   const response=await fetchImpl(url+'/rest/v1/rpc/relay_recovery_request',{method:'POST',
    headers:{'Content-Type':'application/json','apikey':key,'Authorization':'Bearer '+key},
    body:JSON.stringify({p_op:data.op,p_room:data.room,p_auth:await digest(bearer),
     p_setup:data.op==='provision'?await digest(data.setup):null,p_device:data.device||null,
     p_previous:data.previous||null,p_version:data.version||null,p_cipher:data.cipher||null}),
    signal:AbortSignal.timeout(12000)});
   if(!response.ok) {
    // Return bounded, generic errors; database diagnostics may contain private values.
    const error=await response.json().catch(()=>({}));
    const status=error.message==='Unauthorized'?401:error.message==='Conflict'?409:error.message==='Capacity exceeded'?507:503;
    return Response.json({error:status===401?'Unauthorized':status===409?'Conflict':status===507?'Recovery capacity reached':'Recovery unavailable'},{status});
   }
   return Response.json(await response.json(),{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Recovery request failed'},{status:400});}
 };
}
