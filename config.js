const path = require('path');
require('dotenv').config();

const isVercel = process.env.VERCEL === '1';
const useTurso = isVercel && !!process.env.TURSO_URL;

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'skyhonix-super-secret-key-12345-abcde',
  DATABASES_DIR: isVercel ? '/tmp/databases' : path.join(__dirname, 'public', 'databases'),
  UPLOADS_DIR: isVercel ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads'),
  BACKUPS_DIR: isVercel ? '/tmp/backups' : path.join(__dirname, 'public', 'backups'),
  isVercel,
  useTurso,
  TURSO_URL: process.env.TURSO_URL || '',
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
  READONLY_DATABASES_DIR: path.join(__dirname, 'public', 'databases'),
  READONLY_UPLOADS_DIR: path.join(__dirname, 'public', 'uploads'),
  
  // OAuth Configuration
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback',
  
  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID || '',
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID || '',
  APPLE_KEY_ID: process.env.APPLE_KEY_ID || '',
  APPLE_PRIVATE_KEY_PATH: process.env.APPLE_PRIVATE_KEY_PATH || '',
  APPLE_CALLBACK_URL: process.env.APPLE_CALLBACK_URL || 'http://localhost:3000/api/auth/apple/callback',
  
  SESSION_SECRET: process.env.SESSION_SECRET || 'skyhonix-session-secret-12345',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000'
};
