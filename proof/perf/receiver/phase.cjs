// usage: <runtime> --expose-gc phase.cjs <phase.cjs bundle> <body.json> <iterations> [stagingDir]
// Times each step of prepareExport on its own, then prepareExport and stageExport whole.
const { readFileSync, rmSync, mkdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const [bundlePath, bodyPath, iterArg, stagingArg] = process.argv.slice(2);
const lib = require(path.resolve(bundlePath));
const body = readFileSync(bodyPath);
const iterations = Number(iterArg ?? 5);
const stagingDir = stagingArg ?? path.join(path.dirname(bodyPath), '..', 'staging-phase');

function timed(fn) {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  return { value, ms, cpuMs: (cpu.user + cpu.system) / 1000 };
}

function digestFiles(files) {
  const hash = createHash('sha256');
  for (const { relativePath, bytes } of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

async function main() {
  const rows = [];
  let identity = null;
  for (let i = 0; i < iterations; i += 1) {
    const row = {};
    global.gc?.();
    const budget = timed(() => lib.exceedsValueBudget(body));
    row.budget = budget.ms;
    if (!budget.value) {
      const text = timed(() => body.toString('utf8'));
      row.toString = text.ms;
      const parsed = timed(() => JSON.parse(text.value));
      row.jsonParse = parsed.ms;
      const schema = timed(() => lib.parseExportPayload(parsed.value));
      row.schema = schema.ms;
      if (schema.value.ok) {
        const hash = timed(() => lib.hashExport(parsed.value));
        row.hash = hash.ms;
        const bundle = timed(() => {
          try {
            return lib.buildBundleFiles.length === 2
              ? lib.buildBundleFiles(schema.value.payload, parsed.value.nodeId)
              : lib.buildBundleFiles({ ...schema.value.payload });
          } catch (error) {
            return { ok: false, rejection: `threw ${error.name}` };
          }
        });
        row.bundle = bundle.ms;
      }
    }
    global.gc?.();
    const whole = timed(() => lib.prepareExport(body));
    row.prepare = whole.ms;
    row.prepareCpu = whole.cpuMs;
    if (whole.value.ok) {
      rmSync(stagingDir, { recursive: true, force: true });
      mkdirSync(stagingDir, { recursive: true });
      const t0 = performance.now();
      const staged = await lib.stageExport(whole.value.prepared, stagingDir);
      row.stage = performance.now() - t0;
      identity ??= {
        ok: true,
        staged: staged.ok,
        contentHash: whole.value.prepared.lookup.contentHash,
        identity: whole.value.prepared.lookup.identity,
        fileCount: whole.value.prepared.files.length,
        filesDigest: digestFiles(whole.value.prepared.files),
        fileBytes: whole.value.prepared.files.reduce(
          (n, f) => n + (typeof f.bytes === 'string' ? Buffer.byteLength(f.bytes) : f.bytes.length),
          0,
        ),
      };
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      identity ??= { ok: false, rejection: whole.value.rejection };
    }
    rows.push(row);
  }
  const usage = process.resourceUsage();
  console.log(
    JSON.stringify({
      body: path.basename(bodyPath),
      bytes: body.length,
      runtime: `node ${process.versions.node} v8 ${process.versions.v8}`,
      bundle: bundlePath,
      identity,
      maxRssMb: Math.round(usage.maxRSS / 1024),
      rows: rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      ),
    }),
  );
}
main();
