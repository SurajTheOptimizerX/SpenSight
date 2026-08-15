const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Ensure uploads directory exists on launch
if (!fs.existsSync('uploads/')) {
  fs.mkdirSync('uploads/', { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // basename strips any directory traversal attempts from the client name.
    cb(null, `${Date.now()}-${path.basename(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.csv$/i.test(file.originalname)) {
      const error = new Error('Only CSV files are allowed.');
      error.status = 400;
      return cb(error);
    }
    cb(null, true);
  },
});

module.exports = upload;
