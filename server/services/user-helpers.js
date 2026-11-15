import { upsertUser, fileCount } from './nodes.js';
import { usedBytes } from './quota.js';
import { toByteString } from '../lib/bytes.js';

export { upsertUser };
export const usedBytesOf = (email) => toByteString(usedBytes(email));
export const fileCountOf = fileCount;
