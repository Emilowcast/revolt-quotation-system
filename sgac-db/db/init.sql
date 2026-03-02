-- init.sql
-- Script de inicialización para la DB del SGAC
-- (Postgres 12+)
-- Usa pgcrypto para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================
-- SCHEMA: tables & types
-- =========================

-- Roles (simple lookup)
CREATE TABLE IF NOT EXISTS roles (
  id smallserial PRIMARY KEY,
  name varchar(50) NOT NULL UNIQUE,
  description text
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  email varchar(254) NOT NULL UNIQUE,
  password_hash varchar(200) NOT NULL, -- placeholder: en producción usar bcrypt/argon2
  role_id smallint REFERENCES roles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Clients (customers/leads)
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre varchar(200),
  empresa varchar(200),
  email varchar(254),
  telefono varchar(60),
  direccion jsonb, -- flexible
  meta jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_email ON clients( lower(email) );
CREATE INDEX IF NOT EXISTS idx_clients_telefono ON clients( telefono );

-- Products (catalog)
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modelo varchar(120) NOT NULL UNIQUE,
  descripcion text,
  precio numeric(14,2) NOT NULL DEFAULT 0,
  archivo_ficha text, -- filename or URL
  meta jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_modelo ON products( modelo );

-- Product files (fichas técnicas)
CREATE TABLE IF NOT EXISTS product_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  filename varchar(260),
  url text,
  mime varchar(100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Templates (group of versions)
CREATE TABLE IF NOT EXISTS templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(260) NOT NULL,
  description text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Template versions (each upload / version)
CREATE TABLE IF NOT EXISTS template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES templates(id) ON DELETE CASCADE,
  version_number integer NOT NULL DEFAULT 1,
  filename varchar(260) NOT NULL,
  storage_path text NOT NULL, -- path or s3 key
  calibration jsonb DEFAULT '{}'::jsonb, -- guarda coordenadas, tabla startY, etc.
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_template_versions_template ON template_versions(template_id);

-- Quotes (cotizaciones)
CREATE TYPE quote_status AS ENUM ('draft','vigente','enviada','convertida','papelera');

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio varchar(80) UNIQUE,
  template_version_id uuid REFERENCES template_versions(id),
  client_id uuid REFERENCES clients(id),
  vendedor_id uuid REFERENCES users(id),
  status quote_status NOT NULL DEFAULT 'draft',
  data jsonb DEFAULT '{}'::jsonb, -- capturar campos extra, e.g. campos rellenados
  subtotal numeric(14,2) DEFAULT 0,
  descuento numeric(14,2) DEFAULT 0,
  impuestos numeric(14,2) DEFAULT 0,
  total numeric(14,2) DEFAULT 0,
  currency char(3) DEFAULT 'USD',
  exchange_rate numeric(14,6) DEFAULT 1, -- USD->MXN
  net_mxn numeric(14,2), -- Precio neto en MXN (calculated)
  sent boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_folio ON quotes(folio);
CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_id);
CREATE INDEX IF NOT EXISTS idx_quotes_vendedor ON quotes(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

-- Quote items
CREATE TABLE IF NOT EXISTS quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  producto_id uuid REFERENCES products(id),
  modelo varchar(120),
  descripcion text,
  precio numeric(14,2) DEFAULT 0,
  cantidad integer DEFAULT 1,
  subtotal numeric(14,2) DEFAULT 0,
  position integer DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quote_items_quoteid ON quote_items(quote_id);

-- Inbound emails (raw + processing)
CREATE TABLE IF NOT EXISTS inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(80),
  from_email varchar(254),
  from_name varchar(200),
  subject text,
  text_body text,
  html_body text,
  headers jsonb,
  raw jsonb,
  processed boolean DEFAULT false,
  processing_log text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails( lower(from_email) );

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  action varchar(120), -- create_quote, update_template, send_email, etc.
  entity_type varchar(80),
  entity_id uuid,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Full text search / helper (optional)
-- Example tsvector column could añadirse a tablas que lo necesiten.

-- =========================
-- Seed básicos (roles, admin user, product demo, template demo)
-- =========================

-- Roles
INSERT INTO roles (name, description)
VALUES
  ('admin', 'Administrador - acceso total'),
  ('vendedor', 'Usuario vendedor - gestionar cotizaciones propias'),
  ('lector', 'Solo lectura')
ON CONFLICT (name) DO NOTHING;

-- Usuario admin (ejemplo) -- ACTUALIZA password_hash en producción con bcrypt/argon2
INSERT INTO users (name, email, password_hash, role_id)
VALUES ('Administrador', 'admin@revolt.local', 'CHANGE_ME_ADMIN_HASH', (SELECT id FROM roles WHERE name='admin'))
ON CONFLICT (email) DO NOTHING;

-- Cliente demo
INSERT INTO clients (nombre, empresa, email, telefono, direccion)
VALUES ('Cliente Demo','Empresa Demo','cliente@demo.com','+5215511122233', jsonb_build_object('calle','Av. Demo 123','ciudad','Ciudad','cp','01234'))
ON CONFLICT (email) DO NOTHING;

-- Producto demo
INSERT INTO products (modelo, descripcion, precio, archivo_ficha)
VALUES ('RM-042-220', 'Regulador 4 kVA - demo', 987.36, NULL)
ON CONFLICT (modelo) DO NOTHING;

-- Plantilla demo y versión (si quieres reemplazar con archivos reales, actualiza storage_path)
INSERT INTO templates (id, name, description, created_by)
VALUES (gen_random_uuid(), 'Plantilla Demo A4', 'Plantilla base A4 para cotizaciones', NULL)
ON CONFLICT DO NOTHING;

-- Create a template_version for the new inserted template (if not exists)
DO $$
DECLARE
  tpl_id uuid;
BEGIN
  SELECT id INTO tpl_id FROM templates WHERE name = 'Plantilla Demo A4' LIMIT 1;
  IF tpl_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = tpl_id) THEN
      INSERT INTO template_versions (template_id, version_number, filename, storage_path, calibration, created_by)
      VALUES (tpl_id, 1, 'plantilla_demo_a4.pdf', '/templates/plantilla_demo_a4.pdf', '{}'::jsonb, NULL);
    END IF;
  END IF;
END$$;

-- Example quote demo
INSERT INTO quotes (folio, template_version_id, client_id, vendedor_id, subtotal, descuento, impuestos, total, currency, exchange_rate, net_mxn, status)
SELECT 'F-0001', tv.id, c.id, u.id, 987.36, 0, 0, 987.36, 'USD', 17.50, 987.36 * 17.50, 'vigente'
FROM template_versions tv, clients c, users u
WHERE tv.filename = 'plantilla_demo_a4.pdf' AND c.email = 'cliente@demo.com' AND u.email = 'admin@revolt.local'
LIMIT 1
ON CONFLICT DO NOTHING;

-- create a quote item for demo
DO $$
DECLARE qid uuid;
BEGIN
  SELECT id INTO qid FROM quotes WHERE folio='F-0001' LIMIT 1;
  IF qid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quote_items WHERE quote_id=qid) THEN
    INSERT INTO quote_items (quote_id, modelo, descripcion, precio, cantidad, subtotal, position)
    VALUES (qid, 'RM-042-220', 'Regulador 4 kVA - demo', 987.36, 1, 987.36, 1);
  END IF;
END$$;

-- =========================
-- Helpful VIEWs & FUNCTIONS (opcional pero útiles)
-- =========================

-- View: simple quote summary
CREATE OR REPLACE VIEW vw_quote_summary AS
SELECT q.id, q.folio, q.status, q.created_at, q.total, q.currency,
  c.empresa AS cliente_empresa, c.nombre AS cliente_nombre, u.name AS vendedor
FROM quotes q
LEFT JOIN clients c ON q.client_id = c.id
LEFT JOIN users u ON q.vendedor_id = u.id;

-- Trigger to update updated_at on users & quotes
CREATE OR REPLACE FUNCTION trg_update_timestamp() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trg_update_timestamp();

DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION trg_update_timestamp();

-- =========================
-- End init.sql
-- =========================
