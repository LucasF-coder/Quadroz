const { extractBearerToken, verifyToken } = require('./auth');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = extractBearerToken(authHeader);
  if (!token) {
    return res.status(401).json({ error: 'Token ausente.' });
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

function attachOptionalUser(req, _res, next) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    req.user = verifyToken(token);
  } catch {
    req.user = null;
  }
  return next();
}

module.exports = {
  requireAuth,
  attachOptionalUser
};
