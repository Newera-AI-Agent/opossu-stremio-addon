# Opossu — addon Stremio per contenuti italiani legali

Addon pubblico per scoprire film e serie in lingua italiana disponibili da fonti gratuite, ad-supported, di pubblico dominio o con licenza esplicita. Opossu non esegue scraping e non collega, incorpora o facilita servizi pirata.

## Stato delle fonti

Il catalogo incluso contiene dati dimostrativi e pubblici da verificare. Un titolo nel catalogo non implica che una riproduzione sia disponibile. Gli stream sono restituiti soltanto dalla fonte legale configurata dall'operatore; senza configurazione l'endpoint risponde correttamente con `streams: []`.

Prima della pubblicazione, verificare per ogni titolo territorio, licenza, diritti di streaming, URL HTTPS e condizioni pubblicitarie della fonte. Non inserire credenziali o token nel repository.

## Requisiti

- Node.js 20 o superiore
- npm
- Una fonte legale che esponga l'adapter documentato sotto (opzionale in sviluppo)

## Sviluppo

```bash
npm install
npm run dev
```

Il server ascolta sulla porta `3000` per impostazione predefinita. Per una porta diversa usare `PORT`.

## Variabili d'ambiente

| Variabile | Obbligatoria | Descrizione |
| --- | --- | --- |
| `PORT` | no | Porta HTTP, default `3000`. |
| `LEGAL_SOURCE_BASE_URL` | no | URL base HTTPS di un endpoint legale gestito dall'operatore. Deve accettare `GET /streams?id=...&type=movie|series` e restituire un array JSON di stream. |
| `LEGAL_SOURCE_LABEL` | no | Etichetta leggibile della fonte configurata. |

L'adapter non invia segreti e non conserva credenziali. Configurare solo fonti autorizzate e documentare il loro consenso/licenza fuori dal codice.

## Endpoint Stremio

- `GET /manifest.json` — manifest Stremio.
- `GET /catalog/:type/italian-legal.json` — catalogo italiano per `movie` o `series`.
- `GET /meta/:type/:id.json` — metadati di un titolo `opossu:`.
- `GET /stream/:type/:id.json` — stream della fonte legale configurata; array vuoto se nessuna fonte è configurata.
- `GET /health` — stato del servizio.

Gli errori hanno forma JSON `{ "error": "..." }`; gli ID e i tipi sono validati ai confini HTTP.

## Build e test

```bash
npm run typecheck
npm test
npm run build
npm start
```

Il build TypeScript produce `dist/`. I test sono deterministici e verificano manifest, catalogo, metadati, ID malformati, health e assenza di fonte.

## Deploy

Questo progetto è un'API Express long-running, non un sito statico: deve essere eseguito su un host Node.js con le variabili sopra configurate. La richiesta Pages `opossu.newera.page.dev` può servire un artefatto statico solo se la piattaforma supporta anche il runtime API; non dichiarare operativo l'endpoint senza verificare tale runtime.

## Licenza dei contenuti

Il software è separato dai contenuti indicizzati. Chi opera l'addon è responsabile della verifica delle licenze e della rimozione immediata di titoli o fonti non più autorizzati.
