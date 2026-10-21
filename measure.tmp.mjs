import { Buffer } from 'node:buffer';
const RPC='https://api.mainnet-beta.solana.com';
let id=0;
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:m,params:p}),signal:AbortSignal.timeout(30000)});
 const t=await r.text(); const j=JSON.parse(t); return {bytes:Buffer.byteLength(t), json:j, cl:Number(r.headers.get('content-length')||0)};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const slotRes=await rpc('getSlot',[]); const slot=slotRes.json.result;
console.log('slot',slot);
// 1. tx count in a produced block, cheaply (signatures only)
let block=null, tried=0;
for(let s=slot; tried<8; s--, tried++){
  const r=await rpc('getBlock',[s,{transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:0}]);
  await sleep(400);
  if(r.json.result){ block={slot:s, n:(r.json.result.signatures||[]).length, bytes:r.bytes, cl:r.cl, height:r.json.result.blockHeight}; break; }
}
console.log('BLOCK(sig-only):',JSON.stringify(block));
// 2. one FULL jsonParsed block to see real payload size (may be huge -> guard)
if(block){
  const r=await rpc('getBlock',[block.slot,{transactionDetails:'full',rewards:false,logMessages:false,maxSupportedTransactionVersion:0}]);
  console.log('BLOCK(full jsonParsed, no logs): bytes',r.bytes,'contentLength',r.cl,'txns',r.json.result?.transactions?.length);
  const txs=r.json.result?.transactions||[];
  const sample=txs.slice(0,5).map(t=>Buffer.byteLength(JSON.stringify(t)));
  console.log('per-tx json bytes (first 5):',JSON.stringify(sample));
  console.log('avg block bytes/tx:', sample.length? Math.round(sample.reduce((a,b)=>a+b,0)/sample.length):'n/a');
  const withInner=txs.filter(t=>(t.meta?.innerInstructions||[]).length>0).length;
  console.log('txns with innerInstructions:',withInner,'of',txs.length);
}
// 3. a few individual getTransaction sizes for the per-signature strategy
const sg=await rpc('getSignaturesForAddress',['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',{limit:5}]);
const sizes=[];
for(const s of (sg.json.result||[]).slice(0,4)){
  const r=await rpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);
  if(r.json.result) sizes.push({bytes:r.bytes, cl:r.cl, inner:(r.json.result.meta?.innerInstructions||[]).length});
  await sleep(400);
}
console.log('getTransaction sizes:',JSON.stringify(sizes));
