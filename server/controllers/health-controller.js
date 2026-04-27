function health(_req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

module.exports = {
  health
};
