import { execFile } from 'node:child_process';

export type PortHolder = { pid: number; command: string };

// Read-only: lsof names the listener so the conflict message can, and nothing
// here signals it. Any failure, including a missing lsof, reports no holder.
export function findPortHolder(port: number): Promise<PortHolder | undefined> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      { timeout: 1000 },
      (error, stdout) => resolve(error ? undefined : parseHolder(stdout)),
    );
  });
}

// `-F` output is one field per line: `p<pid>` then `c<command>` per process.
export function parseHolder(output: string): PortHolder | undefined {
  const lines = output.split('\n');
  const pidIndex = lines.findIndex((line) => /^p\d+$/.test(line));
  if (pidIndex === -1) return undefined;
  const command = lines.slice(pidIndex + 1).find((line) => line.startsWith('c'));
  if (!command) return undefined;
  return { pid: Number(lines[pidIndex]?.slice(1)), command: command.slice(1) };
}
