import { onRequest } from 'firebase-functions/v2/https';

import { healthHandler } from './health.js';

export const health = onRequest({ region: 'asia-south1' }, healthHandler);
