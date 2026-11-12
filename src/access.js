import crypto from 'node:crypto';

/**
 * The link you share is not the ACCESS_KEY itself. It is a token derived from it, so the
 * secret stays in your environment settings and the link can be handed out freely.
 */
export function shareToken(accessKey) {
  return crypto.createHmac('sha256', accessKey).update('parley-share-link').digest('hex').slice(0, 32);
}

export function cookieToken(accessKey) {
  return crypto.createHmac('sha256', accessKey).update('parley-access').digest('hex');
}
