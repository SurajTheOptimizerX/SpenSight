const db = require('./db');

// Runs on every server boot. Each statement is idempotent so repeated runs
// are safe. Existing accounts are pre-verified exactly once (when the column
// is first added) so no one already using the app is locked out; new signups
// start unverified.
const MIGRATIONS = [
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'is_verified'
    ) THEN
        ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT FALSE;
        UPDATE users SET is_verified = TRUE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'verification_token'
    ) THEN
        ALTER TABLE users ADD COLUMN verification_token VARCHAR(255);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'verification_expires_at'
    ) THEN
        ALTER TABLE users ADD COLUMN verification_expires_at TIMESTAMP WITH TIME ZONE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'verified_at'
    ) THEN
        ALTER TABLE users ADD COLUMN verified_at TIMESTAMP WITH TIME ZONE;
    END IF;
  END $$;
  `,
  // Mail settings table for the admin mail settings page. Single row (id=1).
  // smtp_pass_encrypted stores the SMTP password AES-256-GCM encrypted with a
  // key derived from JWT_SECRET (never returned by the API).
  `
  CREATE TABLE IF NOT EXISTS mail_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    smtp_host VARCHAR(255),
    smtp_port INTEGER DEFAULT 587,
    smtp_user VARCHAR(255),
    smtp_pass_encrypted VARCHAR(255),
    mail_from VARCHAR(255),
    app_name VARCHAR(255) DEFAULT 'SpenSight',
    verify_page_url VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO mail_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `,
];

async function runMigrations() {
  try {
    for (const sql of MIGRATIONS) {
      await db.query(sql);
    }
    console.log('✓ Schema migrations applied (email verification, mail settings).');
  } catch (error) {
    console.error('⚠ Schema migration skipped (database unavailable?):', error.message);
  }
}

module.exports = { runMigrations };
