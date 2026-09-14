import type { CatalogItem, MediaType } from './types.ts';
export const catalog: CatalogItem[] = [
 { id:'opossu:movie:ladri-di-biciclette', type:'movie', name:'Ladri di biciclette', poster:'https://upload.wikimedia.org/wikipedia/commons/7/7e/Ladri_di_biciclette_%281948%29_poster.jpg', description:'Dramma neorealista italiano di Vittorio De Sica (1948). Opera indicata come demo di pubblico dominio/licenza da verificare prima della distribuzione.', releaseInfo:'1948', genres:['Drammatico','Neorealismo'] },
 { id:'opossu:movie:il-viaggio-di-dante', type:'movie', name:'Il viaggio di Dante — demo', poster:'https://images.unsplash.com/photo-1500534623283-312aade485b7?w=600', description:'Elemento dimostrativo: sostituire con un titolo italiano dotato di fonte libera verificata.', releaseInfo:'DEMO', genres:['Demo'] },
 { id:'opossu:series:archivio-italiano', type:'series', name:'Archivio italiano — demo', poster:'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=600', description:'Catalogo dimostrativo per serie: nessun episodio viene dichiarato disponibile senza configurazione di una fonte autorizzata.', releaseInfo:'DEMO', genres:['Documentario'] }
];
export const findItem = (id:string, type:MediaType) => catalog.find(item => item.id === id && item.type === type);
