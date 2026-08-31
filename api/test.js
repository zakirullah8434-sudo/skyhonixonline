module.exports = (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Vercel function is working', path: req.url });
};
