import { createFakeFigma } from './fake-figma.ts';

export const fake = createFakeFigma({ fileKey: 'INSTALLED' });

Object.assign(globalThis, { figma: fake.figma, __html__: '<ui/>' });
