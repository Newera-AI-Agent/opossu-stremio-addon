export type MediaType = 'movie' | 'series';
export interface CatalogItem { id:string; type:MediaType; name:string; poster:string; description:string; releaseInfo:string; genres:string[]; }
export interface LegalStream { title:string; url:string; behaviorHints?:{ notWebReady?:boolean }; }
export interface LegalSourceAdapter { readonly label:string; streamsFor(id:string, type:MediaType): Promise<LegalStream[]>; }
