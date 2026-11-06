export const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// A real-file export carrying only what upstream always sends. Pass a field as
// `undefined` to omit it from the body.
export function exportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outputDir: '/tmp/ignored',
    fileKey: 'fixtureFileKey',
    fileName: 'Fixture file',
    nodeId: '1:2',
    nodeName: 'Fixture frame',
    exportedAt: '2026-01-02T03:04:05.000Z',
    summary: { totalNodes: 1, components: { total: 0, local: 0, remote: 0 } },
    node: { id: '1:2', name: 'Fixture frame', type: 'FRAME' },
    components: [],
    remoteMasters: [],
    ...overrides,
  };
}

export function exportBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify(exportPayload(overrides)));
}
