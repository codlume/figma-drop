import * as NodePath from 'node:path';

import { RECEIVER_PORT } from '@figma-drop/export-contract';

export const DEV_RECEIVER_PORT = 13579;

export type Runtime = {
  userData: string;
  library: string;
  port: number;
  testMode: boolean;
  devServerUrl: string | null;
};

type Env = Readonly<Record<string, string | undefined>>;

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw new Error(`FIGMA_DROP_PORT is not a port: ${value}`);
  return port;
}

// A packaged app reads no environment, so nothing outside the app can move its library. A
// development build reaches `~/figma-drop` or port 3579 only when the environment names them.
export function resolveRuntime(
  env: Env,
  { isPackaged, home, appData }: { isPackaged: boolean; home: string; appData: string },
): Runtime {
  if (isPackaged) {
    return {
      userData: NodePath.join(appData, 'figma-drop'),
      library: NodePath.join(home, 'figma-drop'),
      port: RECEIVER_PORT,
      testMode: false,
      devServerUrl: null,
    };
  }
  const userData = env.FIGMA_DROP_USER_DATA
    ? NodePath.resolve(env.FIGMA_DROP_USER_DATA)
    : NodePath.join(appData, 'figma-drop-dev');
  return {
    userData,
    library: env.FIGMA_DROP_LIBRARY
      ? NodePath.resolve(env.FIGMA_DROP_LIBRARY)
      : NodePath.join(userData, 'library'),
    port: env.FIGMA_DROP_PORT ? parsePort(env.FIGMA_DROP_PORT) : DEV_RECEIVER_PORT,
    testMode: env.FIGMA_DROP_TEST === '1',
    devServerUrl: env.VITE_DEV_SERVER_URL || null,
  };
}
