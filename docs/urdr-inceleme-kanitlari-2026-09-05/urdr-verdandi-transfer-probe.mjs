import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { getEncoding } from '/Users/gencay/Downloads/Verðandi/node_modules/js-tiktoken/dist/index.js';
import { applyContextTax, createSessionLedger, spoolFetch } from '/Users/gencay/Downloads/urdr/scripts/lib/context-tax.mjs';
import { computeHunks } from '/Users/gencay/Downloads/urdr/scripts/lib/file-watch.mjs';
const enc=getEncoding('cl100k_base'); const tok=v=>enc.encode(typeof v==='string'?v:JSON.stringify(v,null,2)).length;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'urdr-transfer-'));
try {
 const lines=Array.from({length:6000},(_,i)=>`export function calculateInvoice${i}(amount: number) { return amount * 1.20; }`);
 const body={file:'invoices.ts',source:lines.join('\n')}; const ledger=createSessionLedger();
 const first=applyContextTax(ledger,root,'urdr_read',{ids:['fixture'],maxReplyTokens:1000},body);
 const repeat=applyContextTax(ledger,root,'urdr_read',{ids:['fixture'],maxReplyTokens:1000},body);
 const full=spoolFetch(root,first.ref,{fromLine:1,toLine:100000}); assert.deepEqual(JSON.parse(full.text),body);
 const sourceLine=spoolFetch(root,first.ref,{fromLine:3,toLine:3});
 const newer=[...lines]; newer[3000]=newer[3000].replace('1.20','1.18');
 const hunks=computeHunks(lines.join('\n'),newer.join('\n')); const restored=[...lines];
 for(const h of [...hunks].reverse()) restored.splice(h.oldStart-1,h.removed.length,...h.added);assert.equal(restored.join('\n'),newer.join('\n'));
 console.log(JSON.stringify({scope:'Synthetic transport test only; no agent/model task or quality evaluation',encoding:'cl100k_base',fullResponseTokens:tok(body),parkedResponseTokens:tok(first),unchangedResponseTokens:tok(repeat),exactRecovery:true,oneFetchedJsonLineTokens:tok(sourceLine),changedHunksTokens:tok(hunks),deltaReconstructionExact:true},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
