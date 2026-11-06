import type { CreateLibrary } from '../shared/integration';
import { openLibrary } from './library';

export const createLibrary: CreateLibrary = (options) => openLibrary(options);
