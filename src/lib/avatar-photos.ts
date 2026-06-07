import { sha256 } from 'js-sha256';

const GRAVATAR_BASE_URL = 'https://www.gravatar.com/avatar';
const FASTMAIL_AVATAR_CDN_BASE_URL = 'https://www.fastmailcdn.com/avatar';

export function getFastmailProfilePhotoUrl(email?: string | null, size = 96) {
  const normalizedEmail = email?.trim().toLowerCase();

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return undefined;
  }

  const hash = sha256(normalizedEmail);
  const avatarSize = Math.max(1, Math.min(2048, Math.round(size)));

  return `${GRAVATAR_BASE_URL}/${hash}?s=${avatarSize}&d=404`;
}

export function getFastmailDomainAvatarUrl(email?: string | null) {
  const domain = getEmailDomain(email);

  if (!domain) {
    return undefined;
  }

  return `${FASTMAIL_AVATAR_CDN_BASE_URL}/${encodeURIComponent(domain)}`;
}

function getEmailDomain(email?: string | null) {
  const normalizedEmail = email?.trim().toLowerCase();
  const atIndex = normalizedEmail?.lastIndexOf('@') ?? -1;

  if (!normalizedEmail || atIndex < 0 || atIndex === normalizedEmail.length - 1) {
    return undefined;
  }

  return normalizedEmail.slice(atIndex + 1);
}
