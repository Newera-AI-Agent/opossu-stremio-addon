import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.ts';
describe('Opossu addon',()=>{
 it('espone un manifest Stremio valido',async()=>{const r=await request(app).get('/manifest.json'); expect(r.status).toBe(200); expect(r.body.resources).toEqual(['catalog','meta','stream']); expect(r.body.types).toContain('movie');});
 it('risponde al catalogo italiano',async()=>{const r=await request(app).get('/catalog/movie/italian-legal.json'); expect(r.status).toBe(200); expect(r.body.metas.length).toBeGreaterThan(0);});
 it('restituisce metadati',async()=>{const r=await request(app).get('/meta/movie/opossu:movie:ladri-di-biciclette.json'); expect(r.status).toBe(200); expect(r.body.meta.name).toContain('Ladri');});
 it('rifiuta ID malformati',async()=>{expect((await request(app).get('/meta/movie/nope.json')).status).toBe(400);});
 it('rende esplicita l indisponibilità senza fonte configurata',async()=>{const r=await request(app).get('/stream/movie/opossu:movie:ladri-di-biciclette.json'); expect(r.status).toBe(200); expect(r.body.streams).toEqual([]);});
 it('espone health',async()=>{expect((await request(app).get('/health')).body.status).toBe('ok');});
});
