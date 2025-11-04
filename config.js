// config.js
const path = require('path');

// Windows'ta dotenv yüklemeyi dene, yoksa pas geç
try {
  require('dotenv').config();
} catch (error) {
  console.log('dotenv not installed, using default config');
}

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || 'localhost'
  },
  rooms: {
    maxUsers: parseInt(process.env.MAX_USERS_PER_ROOM) || 10,
    codeLength: 6,
    inactiveTimeout: 2 * 60 * 60 * 1000,
    maxMessageLength: 500,
    maxUsernameLength: 20
  },
  security: {
    rateLimit: {
      windowMs: 15 * 60 * 1000,
      max: 100
    },
    socketRateLimit: {
      maxEventsPerMinute: 60
    }
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: {
      filename: path.join(__dirname, 'logs', 'app.log'),
      maxsize: 10485760,
      maxFiles: 5
    }
  }
};