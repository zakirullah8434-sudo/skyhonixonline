const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'skyhonix-super-secret-key-12345-abcde',
  DATABASES_DIR: path.join(__dirname, 'public', 'databases'),
  UPLOADS_DIR: path.join(__dirname, 'public', 'uploads'),
  BACKUPS_DIR: path.join(__dirname, 'public', 'backups'),
};
