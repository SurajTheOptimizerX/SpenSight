const { ADMIN_EMAILS } = require('../config/env');

// Restricts a route to the admin email list (ADMIN_EMAILS env var). Must run
// after authMiddleware so req.user exists.
const adminMiddleware = (req, res, next) => {
  const email = req.user && req.user.email;

  if (!email || ADMIN_EMAILS.length === 0 || !ADMIN_EMAILS.includes(String(email).trim().toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  next();
};

module.exports = adminMiddleware;
