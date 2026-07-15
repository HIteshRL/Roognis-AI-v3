function requireInternalToken(req, res, next) {
  const configured = process.env.INTERNAL_SERVICE_TOKEN;
  if (!configured)
    return res.status(500).json({ error: 'Internal service token not configured.' });

  const token = req.headers['x-internal-service-token'];
  if (!token || token !== configured)
    return res.status(401).json({ error: 'Unauthorized' });

  next();
}

module.exports = requireInternalToken;
