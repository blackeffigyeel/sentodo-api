import { readFileSync } from 'fs';
import path from 'path';
import request from 'supertest';
import { parse } from 'yaml';
import { createTestContext } from '../helpers/testApp';

const specPath = path.resolve(__dirname, '../../docs/sentodo.api.doc.yaml');
const spec = parse(readFileSync(specPath, 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

/** Collects "METHOD /full/path" for every route mounted on the Express app. */
function listRoutes(app: unknown): string[] {
  const found: string[] = [];
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) found.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const mount = layer.regexp.source
          .replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\$$/, '')
          .replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');
        walk(layer.handle.stack, prefix + (mount === '/' ? '' : mount));
      }
    }
  };
  walk((app as { _router: { stack: any[] } })._router.stack, '');
  return found;
}

const normalise = (route: string): string =>
  route.replace(/^(\w+) \/api\/v1/, '$1 ').replace(/:\w+/g, '{p}').replace(/\{[^}]+\}/g, '{p}').replace(/\/$/, '').replace(/ \s+/, ' ');

describe('OpenAPI document', () => {
  it('is OpenAPI 3 with unique operation ids and an envelope-based error model', () => {
    expect(spec.openapi).toMatch(/^3\./);
    const ids = Object.values(spec.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(spec.components.responses)).toEqual(
      expect.arrayContaining(['BadRequest', 'Unauthorised', 'Forbidden', 'NotFound', 'Conflict', 'Unprocessable', 'TooManyRequests', 'Unavailable']),
    );
  });

  it('resolves every $ref', () => {
    const text = readFileSync(specPath, 'utf8');
    const refs = [...text.matchAll(/\$ref: '#\/components\/(\w+)\/(\w+)'/g)];
    expect(refs.length).toBeGreaterThan(50);
    for (const [, section, name] of refs) {
      expect((spec.components as Record<string, Record<string, unknown>>)[section][name]).toBeDefined();
    }
  });

  it('documents every route the application serves, and nothing that does not exist', async () => {
    const ctx = await createTestContext();
    const implemented = new Set(listRoutes(ctx.app).filter((r) => r.includes('/api/v1')).map(normalise));
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([p, methods]) => Object.keys(methods).map((m) => normalise(`${m.toUpperCase()} /api/v1${p}`))),
    );
    expect(implemented.size).toBeGreaterThanOrEqual(40);
    expect([...implemented].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !implemented.has(r))).toEqual([]);
  });

  it('is served as JSON and as Swagger UI', async () => {
    const ctx = await createTestContext();
    const json = await request(ctx.app).get('/docs/openapi.json').expect(200);
    expect(json.body.info.title).toBe('Sentodo MFB API');
    const ui = await request(ctx.app).get('/docs/').expect(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
