// Cookie parsing and HttpOnly cookie creation.

const isLocal = process.env.GOTOM_ENV === 'local';

export const parseCookies = (req) => {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
};

export const createSecureCookie = (name, value, maxAge = 31536000) => {
  const secureFlag = isLocal ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly${secureFlag}; SameSite=Strict`;
};
