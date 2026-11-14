// Candidate base64 encoders against the shipped one. Runs in Node and in a browser.
const CHUNK = 3 * 8192;

export const encoders = {
  spread(bytes) {
    let encoded = '';
    for (let start = 0; start < bytes.length; start += CHUNK) {
      encoded += btoa(String.fromCharCode(...bytes.subarray(start, start + CHUNK)));
    }
    return encoded;
  },
  apply(bytes) {
    let encoded = '';
    for (let start = 0; start < bytes.length; start += CHUNK) {
      encoded += btoa(String.fromCharCode.apply(null, bytes.subarray(start, start + CHUNK)));
    }
    return encoded;
  },
  reflect(bytes) {
    let encoded = '';
    for (let start = 0; start < bytes.length; start += CHUNK) {
      encoded += btoa(
        Reflect.apply(String.fromCharCode, null, bytes.subarray(start, start + CHUNK)),
      );
    }
    return encoded;
  },
  native(bytes) {
    return bytes.toBase64();
  },
};

export function run(megabytes, rounds) {
  const bytes = new Uint8Array(megabytes * 1024 * 1024 + 1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 2654435761) >>> 24;
  const results = {};
  let reference;
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, encode] of Object.entries(encoders)) {
      if (name === 'native' && typeof bytes.toBase64 !== 'function') continue;
      const start = performance.now();
      const encoded = encode(bytes);
      const elapsed = performance.now() - start;
      reference ??= encoded;
      if (encoded !== reference) throw new Error(`${name} differs`);
      (results[name] ??= []).push(Math.round(elapsed * 10) / 10);
    }
  }
  return { megabytes, results };
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('b64-micro.mjs')) {
  console.log(JSON.stringify(run(Number(process.argv[2] ?? 32), Number(process.argv[3] ?? 5))));
}
