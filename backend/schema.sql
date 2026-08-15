-- ============================================================
-- SpenSight Database Initialization Schema (v2 - Glass Edition)
-- All category icons are Lucide-style names rendered by the
-- frontend icon library (js/icons.js).
-- ============================================================

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    monthly_income NUMERIC(12, 2) DEFAULT 0.00,
    currency VARCHAR(8) DEFAULT '₹',
    carry_over BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    verification_token VARCHAR(255),
    verification_expires_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Email verification migration for databases created before these columns
-- existed. Idempotent: existing accounts are pre-verified so nobody is
-- locked out; brand-new registrations always start unverified.
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

-- 2. Accounts Table (Cash, Card, Savings, etc.)
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) DEFAULT 'Savings',
    balance NUMERIC(12, 2) DEFAULT 0.00,
    color_code VARCHAR(20) DEFAULT '#3b82f6',
    icon_name VARCHAR(50) DEFAULT 'Wallet',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Categories Table
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    type VARCHAR(20) DEFAULT 'expense', -- 'expense' or 'income'
    icon_name VARCHAR(50) DEFAULT 'Tag',
    color_code VARCHAR(20) DEFAULT '#6B7280',
    CONSTRAINT chk_categories_no_autogen CHECK (name NOT LIKE 'EdgeCat%')
);

-- Seed Default Income and Expense Categories (Lucide icon names)
INSERT INTO categories (name, type, icon_name, color_code) VALUES
-- Income Categories
('Salary', 'income', 'Briefcase', '#22C55E'),
('Freelance', 'income', 'Laptop', '#3B82F6'),
('Rental', 'income', 'Building2', '#84CC16'),
('Refunds', 'income', 'RotateCcw', '#06B6D4'),
('Awards', 'income', 'Trophy', '#3B82F6'),
('Coupons', 'income', 'Ticket', '#EF4444'),
('Grants', 'income', 'Gift', '#10B981'),
('Lottery', 'income', 'Dices', '#8B5CF6'),
('Sale', 'income', 'Tag', '#F59E0B'),
('Investment', 'income', 'TrendingUp', '#059669'),

-- Expense Categories
('Food', 'expense', 'Utensils', '#EF4444'),
('Shopping', 'expense', 'ShoppingBag', '#3B82F6'),
('Bills', 'expense', 'FileText', '#10B981'),
('Car', 'expense', 'Car', '#3B82F6'),
('Home', 'expense', 'Home', '#84CC16'),
('Entertainment', 'expense', 'Film', '#8B5CF6'),
('Health', 'expense', 'HeartPulse', '#EF4444'),
('Education', 'expense', 'GraduationCap', '#1D4ED8'),
('Clothing', 'expense', 'Shirt', '#F59E0B'),
('Electronics', 'expense', 'Cpu', '#06B6D4'),
('Insurance', 'expense', 'ShieldCheck', '#F97316'),
('Social', 'expense', 'Users', '#10B981'),
('Sport', 'expense', 'Dumbbell', '#22C55E'),
('Tax', 'expense', 'Receipt', '#EF4444'),
('Telephone', 'expense', 'Smartphone', '#84CC16'),
('Transportation', 'expense', 'Bus', '#3B82F6'),
('Subscriptions', 'expense', 'Repeat', '#8B5CF6'),
('Travel', 'expense', 'Plane', '#06B6D4'),
('Baby', 'expense', 'Baby', '#8B5CF6'),
('Beauty', 'expense', 'Flower2', '#EC4899'),
('Uncategorized', 'expense', 'HelpCircle', '#6B7280')
ON CONFLICT (name) DO NOTHING;

-- Guardrail: prevent auto-generated / dummy category names (e.g.
-- "EdgeCat161514") from ever being inserted, on existing databases
-- where the categories table was already created without the CHECK.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_categories_no_autogen' AND conrelid = 'categories'::regclass
    ) THEN
        ALTER TABLE categories
        ADD CONSTRAINT chk_categories_no_autogen CHECK (name NOT LIKE 'EdgeCat%');
    END IF;
END $$;

-- 4. Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
    to_account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
    category_id INT REFERENCES categories(id) ON DELETE SET NULL,
    type VARCHAR(20) DEFAULT 'expense', -- 'income', 'expense', 'transfer'
    date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    description TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    notes TEXT,
    is_debit BOOLEAN DEFAULT TRUE,
    source VARCHAR(50) DEFAULT 'manual', -- 'manual' or 'csv_import'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Budgets Table
CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    category_id INT REFERENCES categories(id) ON DELETE CASCADE,
    monthly_limit NUMERIC(12, 2) NOT NULL,
    month_year VARCHAR(7) NOT NULL DEFAULT TO_CHAR(CURRENT_DATE, 'YYYY-MM'),
    CONSTRAINT unique_user_category_month UNIQUE(user_id, category_id, month_year)
);

-- 6. Financial Health Summary Table
CREATE TABLE IF NOT EXISTS financial_health_summary (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    health_score INT NOT NULL,
    savings_rate NUMERIC(5, 2) NOT NULL,
    month_year VARCHAR(7) NOT NULL,
    overall_status VARCHAR(20) DEFAULT 'Healthy',
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_month_health UNIQUE(user_id, month_year)
);

-- 7. AI Insights Table
CREATE TABLE IF NOT EXISTS ai_insights (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    severity VARCHAR(20) DEFAULT 'low',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Database Performance Indexes
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_type ON transactions(user_id, type);
CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, month_year);
CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_insights(user_id);
