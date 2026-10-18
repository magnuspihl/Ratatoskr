import { useState } from 'react';
import type { Address } from '../../../shared/types';
import { avatarColor, avatarUrl, initials } from '../util';

/** Addresses without a picture, so their initials show straight away next time. */
const missing = new Set<string>();

/**
 * A sender's picture (fetched through our server), over their initials. The initials show until
 * the picture has loaded, and stay if there is none.
 */
export function Avatar({ address, small, photos }: { address: Address | undefined; small?: boolean; photos: boolean }) {
  const email = address?.address ?? '';
  const url = photos ? avatarUrl(email) : null;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [, setFailed] = useState(0);
  const tryPhoto = url !== null && !missing.has(url);
  return (
    <span className={`avatar ${small ? 'small' : ''}`} style={{ background: avatarColor(email) }} aria-hidden="true">
      {initials(address)}
      {tryPhoto && (
        <img
          key={url}
          src={url}
          alt=""
          className={loaded === url ? 'loaded' : ''}
          onLoad={() => setLoaded(url)}
          onError={() => {
            missing.add(url);
            setFailed((n) => n + 1);
          }}
        />
      )}
    </span>
  );
}
