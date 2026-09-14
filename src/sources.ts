import type { LegalSourceAdapter, LegalStream, MediaType } from './types.ts';
export class ConfiguredLegalSource implements LegalSourceAdapter {
 readonly label:string;
 private readonly baseUrl:string|undefined;
 constructor(env:NodeJS.ProcessEnv = process.env) { this.baseUrl=env.LEGAL_SOURCE_BASE_URL; this.label=env.LEGAL_SOURCE_LABEL || 'Fonte legale configurata'; }
 async streamsFor(id:string, type:MediaType):Promise<LegalStream[]> {
  if (!this.baseUrl) return [];
  const url = new URL('/streams', this.baseUrl); url.searchParams.set('id',id); url.searchParams.set('type',type);
  const response=await fetch(url,{headers:{accept:'application/json'}});
  if (!response.ok) throw new Error(`Fonte legale non disponibile (${response.status})`);
  const data:unknown=await response.json();
  if (!Array.isArray(data)) throw new Error('Risposta fonte legale non valida');
  return data.filter((entry):entry is LegalStream => typeof entry==='object' && entry!==null && typeof (entry as Record<string,unknown>).title==='string' && typeof (entry as Record<string,unknown>).url==='string');
 }
}
