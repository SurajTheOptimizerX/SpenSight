const { Pool } = require('pg');

// Check if DATABASE_URL exists (set via Render / .env file)
const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.NODE_ENV === 'production') {
  console.error('FATAL: DATABASE_URL environment variable is missing in production!');
}

const poolConfig = connectionString
  ? {
      connectionString: connectionString,
      ssl: {
        rejectUnauthorized: false, // Required for Neon cloud SSL
      },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
      query_timeout: 20000,
    }
  : {
      // Local development fallback
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'spensight_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      query_timeout: 20000,
    };

const dbPool = new Pool(poolConfig);

dbPool.on('connect', () => {
  console.log(`Connected to PostgreSQL Database (${connectionString ? 'Cloud/Neon' : 'Localhost'})`);
});

dbPool.on('error', (err) => {
  console.error('PostgreSQL Connection Pool Error:', err);
});

module.exports = {
  query: (text, params) => dbPool.query(text, params),
  pool: dbPool,
};
