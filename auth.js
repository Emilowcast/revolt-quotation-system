// auth.js - Configuración y utilidades de autenticación
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ============================================
// CONFIGURACIÓN
// ============================================

const AUTH_CONFIG = {
  JWT_SECRET: process.env.JWT_SECRET || 'revolt-secret-key-change-in-production-2025',
  JWT_EXPIRES_IN: '7d', // 7 días
  BCRYPT_ROUNDS: 10,
  COOKIE_NAME: 'revolt_token',
  COOKIE_OPTIONS: {
    httpOnly: true, // No accesible desde JavaScript (seguridad XSS)
    secure: process.env.NODE_ENV === 'production', // Solo HTTPS en producción
    sameSite: 'strict', // Protección CSRF
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días en milisegundos
  }
};

// ============================================
// UTILIDADES DE PASSWORD
// ============================================

/**
 * Hashear password con bcrypt
 * @param {string} password - Password en texto plano
 * @returns {Promise<string>} - Password hasheado
 */
async function hashPassword(password) {
  return await bcrypt.hash(password, AUTH_CONFIG.BCRYPT_ROUNDS);
}

/**
 * Verificar password contra hash
 * @param {string} password - Password en texto plano
 * @param {string} hash - Hash almacenado en BD
 * @returns {Promise<boolean>} - true si coincide
 */
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// ============================================
// UTILIDADES DE JWT
// ============================================

/**
 * Generar JWT token
 * @param {object} payload - Datos a incluir en el token (user id, email, role)
 * @returns {string} - JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, AUTH_CONFIG.JWT_SECRET, {
    expiresIn: AUTH_CONFIG.JWT_EXPIRES_IN
  });
}

/**
 * Verificar y decodificar JWT token
 * @param {string} token - JWT token
 * @returns {object|null} - Payload decodificado o null si es inválido
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, AUTH_CONFIG.JWT_SECRET);
  } catch (e) {
    console.error('❌ Token inválido:', e.message);
    return null;
  }
}

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================

/**
 * Middleware: Requiere autenticación
 * Verifica que el usuario esté autenticado con un token válido
 */
function requireAuth(req, res, next) {
  try {
    // Obtener token de la cookie
    const token = req.cookies[AUTH_CONFIG.COOKIE_NAME];
    
    if (!token) {
      console.warn('⚠️ No hay token en la cookie');
      return res.status(401).json({ 
        ok: false, 
        error: 'No autenticado',
        redirect: '/login.html'
      });
    }
    
    // Verificar token
    const decoded = verifyToken(token);
    
    if (!decoded) {
      console.warn('⚠️ Token inválido o expirado');
      return res.status(401).json({ 
        ok: false, 
        error: 'Token inválido',
        redirect: '/login.html'
      });
    }
    
    // Agregar usuario al request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role
    };
    
    console.log('✅ Usuario autenticado:', req.user.email, `(${req.user.role})`);
    
    next();
  } catch (e) {
    console.error('❌ Error en requireAuth:', e);
    return res.status(500).json({ ok: false, error: 'Error de autenticación' });
  }
}

/**
 * Middleware: Requiere rol específico
 * @param {string[]} allowedRoles - Array de roles permitidos
 * @returns {Function} - Middleware function
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        ok: false, 
        error: 'No autenticado' 
      });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      console.warn(`⚠️ Acceso denegado: ${req.user.email} (${req.user.role}) intentó acceder a ruta de [${allowedRoles.join(', ')}]`);
      return res.status(403).json({ 
        ok: false, 
        error: 'No tienes permiso para esta acción',
        requiredRole: allowedRoles,
        yourRole: req.user.role
      });
    }
    
    next();
  };
}

/**
 * Middleware: Solo Admin
 */
function requireAdmin(req, res, next) {
  return requireRole(['admin'])(req, res, next);
}

// ============================================
// UTILIDADES DE VALIDACIÓN
// ============================================

/**
 * Validar email
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validar password
 * @param {string} password
 * @returns {object} - { valid: boolean, error: string }
 */
function validatePassword(password) {
  if (!password || password.length < 6) {
    return { valid: false, error: 'Password debe tener al menos 6 caracteres' };
  }
  
  if (password.length > 100) {
    return { valid: false, error: 'Password demasiado largo' };
  }
  
  return { valid: true };
}

/**
 * Validar rol
 * @param {string} role
 * @returns {boolean}
 */
function isValidRole(role) {
  return ['admin', 'vendedor'].includes(role);
}

// ============================================
// EXPORTAR
// ============================================

module.exports = {
  AUTH_CONFIG,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
  requireRole,
  requireAdmin,
  isValidEmail,
  validatePassword,
  isValidRole
};