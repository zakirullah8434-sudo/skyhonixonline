const path = require('path');
require('dotenv').config();

const isVercel = process.env.VERCEL === '1';

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'skyhonix-super-secret-key-12345-abcde',
  DATABASES_DIR: isVercel ? '/tmp/databases' : path.join(__dirname, 'public', 'databases'),
  UPLOADS_DIR: isVercel ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads'),
  BACKUPS_DIR: isVercel ? '/tmp/backups' : path.join(__dirname, 'public', 'backups'),
  isVercel,
  READONLY_DATABASES_DIR: path.join(__dirname, 'public', 'databases'),
  READONLY_UPLOADS_DIR: path.join(__dirname, 'public', 'uploads')
};
