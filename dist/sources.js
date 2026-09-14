export class ConfiguredLegalSource {
    label;
    baseUrl;
    constructor(env = process.env) { this.baseUrl = env.LEGAL_SOURCE_BASE_URL; this.label = env.LEGAL_SOURCE_LABEL || 'Fonte legale configurata'; }
    async streamsFor(id, type) {
        if (!this.baseUrl)
            return [];
        const url = new URL('/streams', this.baseUrl);
        url.searchParams.set('id', id);
        url.searchParams.set('type', type);
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok)
            throw new Error(`Fonte legale non disponibile (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data))
            throw new Error('Risposta fonte legale non valida');
        return data.filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.title === 'string' && typeof entry.url === 'string');
    }
}
