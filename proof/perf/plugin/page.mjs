// Browser side of the harness. `window.bench` is driven from the outside.
import { run as b64 } from '/h/b64-micro.mjs';
import { buildDocument, DOCUMENTS } from '/h/docs.mjs';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const loaded = new Map();
async function side(name) {
  if (!loaded.has(name)) {
    const src = `/${name}/apps/figma-plugin/src`;
    const [fake, exporter, payload, transport] = await Promise.all([
      import(`${src}/sandbox/testing/fake-figma.ts`),
      import(`${src}/sandbox/export-node.ts`),
      import(`${src}/ui/payload.ts`),
      import(`${src}/ui/transport.ts`),
    ]);
    loaded.set(name, { ...fake, ...exporter, ...payload, ...transport });
  }
  return loaded.get(name);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stat = (values) => ({
  median: +median(values).toFixed(1),
  min: +Math.min(...values).toFixed(1),
  max: +Math.max(...values).toFixed(1),
});
const now = () => performance.now();

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Alternates the sides inside each round, and flips the order every round.
async function ui(sideNames, docName, rounds = 5, warmup = 1) {
  const base = await side(sideNames[0]);
  const { fake, root } = buildDocument(base.createFakeFigma, DOCUMENTS[docName]);
  const raw = { ...(await base.exportNode(fake.figma, root)), exportedAt: FIXED_TIME };
  const samples = {};
  const report = { doc: docName, totalNodes: raw.summary.totalNodes, sides: {} };
  for (let round = 0; round < warmup + rounds; round += 1) {
    const order = round % 2 === 0 ? sideNames : sideNames.toReversed();
    for (const name of order) {
      window.progress = `${docName} round ${round} ${name}`;
      const api = await side(name);
      const t0 = now();
      const cloned = structuredClone({ type: 'node-exported', raw }).raw;
      const t1 = now();
      const payload = api.encodeExport(cloned);
      const t2 = now();
      const body = JSON.stringify(payload);
      const t3 = now();
      const outcome = await api.sendExport(payload, { baseUrl: location.origin });
      const t4 = now();
      const bodyBytes = new Blob([body]).size;
      if (outcome.kind !== 'saved' || Number(outcome.path) !== bodyBytes) {
        throw new Error(`${name}: ${JSON.stringify(outcome)} for ${bodyBytes} bytes`);
      }
      report.sides[name] ??= { bodyBytes, sha256: await sha256(body) };
      if (round < warmup) continue;
      const into = (samples[name] ??= {
        clone: [],
        encode: [],
        stringify: [],
        send: [],
        total: [],
      });
      into.clone.push(t1 - t0);
      into.encode.push(t2 - t1);
      into.stringify.push(t3 - t2);
      into.send.push(t4 - t3);
      into.total.push(t1 - t0 + (t2 - t1) + (t4 - t3));
    }
  }
  for (const [name, phases] of Object.entries(samples)) {
    report.sides[name].ms = Object.fromEntries(
      Object.entries(phases).map(([phase, values]) => [phase, stat(values)]),
    );
  }
  (window.partial ??= []).push(report);
  return report;
}

// The UI work between the sandbox message and the POST, with no network.
async function encode(sideNames, docName, rounds = 7, warmup = 1) {
  const first = await side(sideNames[0]);
  const { fake, root } = buildDocument(first.createFakeFigma, DOCUMENTS[docName]);
  const raw = { ...(await first.exportNode(fake.figma, root)), exportedAt: FIXED_TIME };
  const rawBytes = [
    raw.svgBytes,
    raw.pngBytes,
    ...raw.icons.map((icon) => icon.bytes),
    ...raw.images.map((image) => image.bytes),
  ].reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0);
  const samples = {};
  const report = { doc: docName, totalNodes: raw.summary.totalNodes, rawBytes, sides: {} };
  for (let round = 0; round < warmup + rounds; round += 1) {
    const order = round % 2 === 0 ? sideNames : sideNames.toReversed();
    for (const name of order) {
      window.progress = `${docName} round ${round} ${name}`;
      const api = await side(name);
      const cloned = structuredClone({ type: 'node-exported', raw }).raw;
      const t1 = now();
      const payload = api.encodeExport(cloned);
      const t2 = now();
      const body = JSON.stringify(payload);
      const t3 = now();
      report.sides[name] ??= { bodyChars: body.length, sha256: await sha256(body) };
      if (round < warmup) continue;
      const into = (samples[name] ??= { encode: [], stringify: [] });
      into.encode.push(t2 - t1);
      into.stringify.push(t3 - t2);
    }
  }
  for (const [name, phases] of Object.entries(samples)) {
    report.sides[name].ms = Object.fromEntries(
      Object.entries(phases).map(([phase, values]) => [phase, stat(values)]),
    );
  }
  (window.partial ??= []).push(report);
  return report;
}

async function sandbox(sideNames, docName, rounds = 5, warmup = 2) {
  const report = { doc: docName, sides: {} };
  const built = {};
  for (const name of sideNames) {
    const api = await side(name);
    built[name] = { api, ...buildDocument(api.createFakeFigma, DOCUMENTS[docName]) };
  }
  const samples = {};
  for (let round = 0; round < warmup + rounds; round += 1) {
    const order = round % 2 === 0 ? sideNames : sideNames.toReversed();
    for (const name of order) {
      const { api, fake, root } = built[name];
      const start = now();
      const raw = await api.exportNode(fake.figma, root);
      const elapsed = now() - start;
      if (round >= warmup) (samples[name] ??= []).push(elapsed);
      if (!report.sides[name]) {
        const body = JSON.stringify(api.encodeExport({ ...raw, exportedAt: FIXED_TIME }));
        report.sides[name] = { totalNodes: raw.summary.totalNodes, sha256: await sha256(body) };
      }
    }
  }
  for (const [name, values] of Object.entries(samples)) report.sides[name].ms = stat(values);
  return report;
}

// A driver call times out after 15 s, so long work runs as a named job that is polled.
window.jobs = {};
window.start = (name, task) => {
  window.jobs[name] = 'pending';
  task().then(
    (value) => {
      window.jobs[name] = value;
    },
    (error) => {
      window.jobs[name] = { error: String(error?.stack ?? error) };
    },
  );
  return `started ${name}`;
};
window.bench = { b64, ui, encode, sandbox, userAgent: navigator.userAgent };
document.getElementById('out').textContent = 'ready';
